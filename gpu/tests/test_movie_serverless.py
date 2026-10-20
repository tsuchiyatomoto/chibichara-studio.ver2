import hashlib
import io
import json
import time

import pytest

from movie_worker.serverless import run_movie


class Body(io.BytesIO):
    def __enter__(self):
        # Boto's StreamingBody context returns a raw reader without iter_chunks.
        return io.BytesIO(self.getvalue())

    def iter_chunks(self, size):
        while data := self.read(size):
            yield data


class Storage:
    def __init__(self):
        self.files = {}

    def get_object(self, *, Bucket, Key):
        if Key not in self.files:
            error = KeyError(Key)
            error.response = {"Error": {"Code": "NoSuchKey"}}
            raise error
        data = self.files[Key]
        return {"Body": Body(data), "ContentLength": len(data)}

    def put_object(self, *, Bucket, Key, Body, **kwargs):
        self.files[Key] = Body

    def upload_file(self, path, bucket, key, **kwargs):
        from pathlib import Path
        self.files[key] = Path(path).read_bytes()


@pytest.fixture
def case(tmp_path, monkeypatch):
    monkeypatch.setenv("MOVIE_S3_BUCKET", "test")
    owner, ident = "anon_" + "a" * 32, "b" * 32
    prefix = f"movie-temp/{owner}/{ident}/"
    storage = Storage()
    data = b"test-movie"
    chunk = prefix + "chunks/0-" + hashlib.sha256(data).hexdigest()
    storage.files[chunk] = data
    frames = [f"avatar-0-{i}.png" for i in range(4)]
    for name in frames:
        storage.files[prefix + name] = b"png"
    voice_key = prefix + "voice-" + hashlib.sha256(b"voice").hexdigest() + ".safetensors"
    storage.files[voice_key] = b"voice"
    manifest = {"owner": owner, "expires": time.time() + 3600, "submitted": True,
                "chunks": [chunk], "voiceKey": voice_key, "job": {"id": ident, "name": "test.mp4", "size": len(data), "received": len(data),
                "avatar": {"poses": [{"frames": frames}]}}}
    key = prefix + "manifest.json"
    storage.files[key] = json.dumps(manifest).encode()
    return storage, {"id": "run-test", "input": {"manifest_key": key}}, prefix, tmp_path


class Engine:
    def __init__(self, store):
        self.store = store

    def perform(self, ident, task):
        with self.store.connect() as db:
            assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        directory = self.store.directory(ident)
        assert (directory / "input.mp4").read_bytes() == b"test-movie"
        if task == "inspect":
            self.store.patch(ident, state="ready")
        else:
            (directory / "output.mp4").write_bytes(b"completed-video")
            (directory / "commentary.wav").write_bytes(b"completed-audio")
            self.store.patch(ident, state="completed")


def execute(case, engine=Engine):
    storage, payload, _, scratch = case
    return run_movie(payload, client=storage, engine_factory=engine,
                     prepare_voice=lambda *_: {}, scratch=scratch)


def test_completed_download_survives_local_cleanup(case):
    storage, _, prefix, scratch = case
    result = execute(case)
    assert result["state"] == "completed"
    assert list(scratch.iterdir()) == []
    assert storage.files[prefix + "output.mp4"] == b"completed-video"
    public = json.loads(storage.files[prefix + "result.json"])
    assert public["id"] == "b" * 32
    assert "owner" not in public and "snapshot_path" not in public
    assert not any("sqlite" in key or key.endswith("-wal") for key in storage.files)


def test_downloaded_speaker_is_accepted_by_real_synthesis_precondition(case):
    from movie_worker.pipeline import Engine as MovieEngine

    class SynthesisCheckingEngine(Engine):
        def perform(self, ident, task):
            if task == "analyze":
                # No segments are synthesized, but the real engine verifies the
                # downloaded speaker file against the job's snapshot metadata.
                MovieEngine(self.store).synthesize(ident, [], preview=False)
            super().perform(ident, task)

    result = execute(case, engine=SynthesisCheckingEngine)
    assert result["state"] == "completed"


def test_processing_failure_cleans_sqlite_and_does_not_publish_result(case):
    class Failing(Engine):
        def perform(self, *_):
            raise RuntimeError("failed")
    with pytest.raises(RuntimeError):
        execute(case, Failing)
    storage, _, prefix, scratch = case
    assert list(scratch.iterdir()) == []
    assert prefix + "result.json" not in storage.files


def test_output_upload_failure_never_marks_completed(case):
    storage, _, prefix, scratch = case
    def fail(*args, **kwargs):
        raise OSError("upload failed")
    storage.upload_file = fail
    with pytest.raises(OSError):
        execute(case)
    assert prefix + "result.json" not in storage.files
    assert list(scratch.iterdir()) == []


def test_cancelled_job_cleans_scratch_and_never_uploads_video(case):
    storage, _, prefix, scratch = case
    storage.files[prefix + "cancel.json"] = b"{}"
    result = execute(case)
    assert result["state"] == "cancelled"
    assert prefix + "output.mp4" not in storage.files
    assert json.loads(storage.files[prefix + "result.json"])["state"] == "cancelled"
    assert list(scratch.iterdir()) == []


@pytest.mark.parametrize("change", ["owner", "expiry", "chunk", "avatar", "voice", "checksum"])
def test_rejects_foreign_expired_or_unsafe_inputs(case, change):
    storage, payload, _, _ = case
    key = payload["input"]["manifest_key"]
    manifest = json.loads(storage.files[key])
    if change == "owner": manifest["owner"] = "another-owner"
    if change == "expiry": manifest["expires"] = 0
    if change == "chunk": manifest["chunks"] = ["movie-temp/another-owner/chunks/0"]
    if change == "avatar": manifest["job"]["avatar"]["poses"][0]["frames"][0] = "../../secret"
    if change == "voice": manifest["voiceKey"] = "movie-temp/another-owner/voice.safetensors"
    if change == "checksum": storage.files[manifest["chunks"][0]] = b"corrupted"
    storage.files[key] = json.dumps(manifest).encode()
    with pytest.raises(ValueError):
        execute(case)
