"""One movie per Runpod job. SQLite and intermediate media never leave local disk."""

import hashlib
import json
import os
import re
import shutil
import tempfile
import time
import sys
import traceback
from pathlib import Path

from .store import Store

MANIFEST = re.compile(r"movie-temp/(anon_[a-f0-9]{32})/([a-f0-9]{32})/manifest\.json")


class MovieCancelled(Exception):
    pass


def has_cancel_request(client, bucket, prefix):
    try:
        read_json(client, bucket, prefix + "cancel.json")
        return True
    except Exception as error:
        if getattr(error, "response", {}).get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
            return False
        raise


def s3_client():
    import boto3
    from botocore.config import Config
    return boto3.client(
        "s3", endpoint_url=os.environ.get("MOVIE_S3_ENDPOINT"),
        region_name=os.environ.get("MOVIE_S3_REGION", "auto"),
        aws_access_key_id=os.environ.get("MOVIE_S3_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("MOVIE_S3_SECRET_ACCESS_KEY"),
        config=Config(
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            s3={"addressing_style": "path" if os.environ.get("MOVIE_S3_FORCE_PATH_STYLE") == "true" else "auto"},
            connect_timeout=10, read_timeout=60, retries={"max_attempts": 3},
        ),
    )


def read_json(client, bucket, key):
    response = client.get_object(Bucket=bucket, Key=key)
    with response["Body"] as body:
        data = body.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise ValueError("Manifest is too large.")
    return json.loads(data)


def download(client, bucket, key, target, limit):
    response = client.get_object(Bucket=bucket, Key=key)
    body = response["Body"]
    if response["ContentLength"] > limit:
        body.close()
        raise ValueError("Input exceeds its size limit.")
    total = 0
    # StreamingBody.__enter__ returns the underlying HTTPResponse, which does
    # not provide iter_chunks. Keep using the StreamingBody wrapper itself.
    with body, target.open("wb") as output:
        for chunk in body.iter_chunks(1024 * 1024):
            total += len(chunk)
            if total > limit:
                raise ValueError("Input exceeds its size limit.")
            output.write(chunk)
    return total


def run_movie(payload, *, client=None, engine_factory=None, prepare_voice=None, scratch=None):
    key = payload.get("input", {}).get("manifest_key", "")
    match = MANIFEST.fullmatch(key)
    if not match:
        raise ValueError("Invalid movie manifest key.")
    owner, public_id = match.groups()
    prefix = key[:-len("manifest.json")]
    bucket = os.environ["MOVIE_S3_BUCKET"]
    client = client or s3_client()
    manifest = read_json(client, bucket, key)
    original = manifest["job"]
    if manifest["owner"] != owner or original["id"] != public_id or not manifest.get("submitted"):
        raise ValueError("Invalid movie owner or job.")
    if manifest["expires"] <= time.time():
        raise ValueError("Movie inputs have expired.")
    if payload.get("id"):
        client.put_object(Bucket=bucket, Key=prefix + "receipt.json",
                          Body=json.dumps({"runId": payload["id"]}).encode(), ContentType="application/json")
    max_bytes = int(os.environ.get("MOVIE_MAX_BYTES", 20 * 1024**3))
    size = original["size"]
    if not isinstance(size, int) or not 0 < size <= max_bytes or original["received"] != size:
        raise ValueError("Invalid input size.")
    # Only this path is used for SQLite. Do not inherit a network-backed DATA_ROOT.
    root = Path(scratch or os.environ.get("MOVIE_LOCAL_TMP", "/tmp/chibichara-movie")).resolve()
    if root == Path("/runpod-volume") or Path("/runpod-volume") in root.parents:
        raise ValueError("Movie scratch must be local, outside /runpod-volume.")
    root.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(root).free < size * 2 + 2 * 1024**3:
        raise ValueError("Insufficient local scratch space.")
    with tempfile.TemporaryDirectory(prefix="job-", dir=root) as temp:
        store = Store(Path(temp))
        local = store.create(owner, original["name"], size)
        ident = local["id"]
        directory = store.directory(ident)
        received = 0
        with (directory / "input.mp4").open("wb") as output:
            for chunk_key in manifest["chunks"]:
                chunk_match = re.fullmatch(re.escape(prefix) + r"chunks/(\d+)-([a-f0-9]{64})", chunk_key)
                if not chunk_match or int(chunk_match[1]) != received:
                    raise ValueError("Invalid chunk sequence.")
                target = directory / "chunk.tmp"
                received += download(client, bucket, chunk_key, target, min(8 * 1024**2, size - received))
                if hashlib.sha256(target.read_bytes()).hexdigest() != chunk_match[2]:
                    raise ValueError("Input checksum mismatch.")
                with target.open("rb") as source:
                    shutil.copyfileobj(source, output)
                target.unlink()
        if received != size:
            raise ValueError("Incomplete upload.")
        avatar = original.get("avatar")
        if not avatar or not 1 <= len(avatar["poses"]) <= 3:
            raise ValueError("Avatar is required.")
        for pose in avatar["poses"]:
            if len(pose["frames"]) != 4:
                raise ValueError("Invalid avatar frames.")
            for name in pose["frames"]:
                if not re.fullmatch(r"avatar-[0-2]-[0-3]\.png", name):
                    raise ValueError("Invalid avatar filename.")
                download(client, bucket, prefix + name, directory / name, 10 * 1024**2)
        voice = directory / "voice.speaker.safetensors"
        voice_key = manifest.get("voiceKey", "")
        if not re.fullmatch(re.escape(prefix) + r"voice-[a-f0-9]{64}\.safetensors", voice_key):
            raise ValueError("Invalid voice key.")
        download(client, bucket, voice_key, voice, 10 * 1024**2)
        voice_hash = hashlib.sha256(voice.read_bytes()).hexdigest()
        if voice_hash != voice_key[len(prefix) + 6:-len(".safetensors")]:
            raise ValueError("Speaker checksum mismatch.")
        if prepare_voice is None:
            from safetensors.numpy import load_file
            import numpy as np
            from .pipeline import fingerprint
            embedding = load_file(voice).get("speaker_embedding")
            if embedding is None or embedding.ndim != 2 or not np.isfinite(embedding).all():
                raise ValueError("Invalid speaker embedding.")
            identity = fingerprint(owner)
        else:
            identity = prepare_voice(voice, owner)
        store.patch(ident, received=size, avatar=avatar, glossary=manifest.get("glossary", ""),
                    snapshot_path=str(voice), voice={"hash": voice_hash}, tts_fingerprint=identity,
                    game_gain=original.get("game_gain", 1), voice_gain=original.get("voice_gain", 1))
        if engine_factory is None:
            from .pipeline import Engine
            engine_factory = Engine
        engine = engine_factory(store)
        original_check = getattr(engine, "check", lambda _: None)
        next_cancel_check = 0

        def check(ident):
            nonlocal next_cancel_check
            original_check(ident)
            if time.monotonic() >= next_cancel_check:
                next_cancel_check = time.monotonic() + 3
                if has_cancel_request(client, bucket, prefix):
                    raise MovieCancelled()

        engine.check = check
        # Synchronous calls keep the Runpod job running until ALL GPU/media work
        # and the output upload finish; do not start Engine's background loop.
        try:
            check(ident)
            engine.perform(ident, "inspect")
            engine.perform(ident, "analyze")
            next_cancel_check = 0
            check(ident)
        except MovieCancelled:
            result = store.public(store.get(ident))
            result.update(id=public_id, state="cancelled", message="処理を中止しました。", updated=time.time())
            client.put_object(Bucket=bucket, Key=prefix + "result.json", Body=json.dumps(result).encode(), ContentType="application/json")
            return {"id": public_id, "state": "cancelled"}
        completed = store.get(ident)
        if completed["state"] != "completed":
            raise RuntimeError("Movie conversion did not complete.")
        for name, content_type in (("output.mp4", "video/mp4"), ("commentary.wav", "audio/wav")):
            client.upload_file(str(directory / name), bucket, prefix + name, ExtraArgs={"ContentType": content_type})
        result = store.public(completed)
        result.update(id=public_id, updated=time.time())
        # Publish the result only after both downloads are safely available.
        client.put_object(Bucket=bucket, Key=prefix + "result.json", Body=json.dumps(result).encode(), ContentType="application/json")
        return {"id": public_id, "state": "completed"}


def handler(payload):
    try:
        return run_movie(payload)
    except Exception as error:
        # Frame locations aid diagnosis without logging provider exception text.
        print(f"Movie conversion failed ({type(error).__name__}).", file=sys.stderr)
        traceback.print_tb(error.__traceback__, file=sys.stderr)
        # SDK exposes exception messages to API clients: never return S3 credentials,
        # provider responses, local paths, or signed URLs from arbitrary exceptions.
        raise RuntimeError("Movie conversion failed. Check worker logs and input configuration.") from None


if __name__ == "__main__":
    import runpod
    runpod.serverless.start({"handler": handler})
