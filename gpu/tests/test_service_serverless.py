import hashlib
import json
import time

import pytest

from service_serverless import Cancelled, run_service_job
from test_movie_serverless import Storage


@pytest.fixture
def case(tmp_path, monkeypatch):
    monkeypatch.setenv("MOVIE_S3_BUCKET", "test")
    owner, ident = "anon_" + "a" * 32, "job_" + "b" * 32
    prefix = f"movie-temp/services/{owner}/image/{ident}/"
    content = b"input-image"
    digest = hashlib.sha256(content).hexdigest()
    manifest = {"version": 1, "owner": owner, "kind": "image", "id": ident, "expires": time.time() + 3600, "payload": {},
                "job": {"id": ident, "status": "queued"}, "files": [
                    {"key": prefix + "inputs/0-" + digest, "sha256": digest, "name": "input", "type": "image/png", "bytes": len(content)}]}
    storage = Storage()
    storage.files[prefix + "manifest.json"] = json.dumps(manifest).encode()
    storage.files[manifest["files"][0]["key"]] = content
    return storage, {"id": "run-id", "input": {"manifest_key": prefix + "manifest.json"}}, prefix, tmp_path


class Service:
    closed = False

    def __init__(self, kind, root, check, progress):
        self.check, self.progress, self.root = check, progress, root
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True

    def run(self, manifest, files):
        assert files[0][1].read_bytes() == b"input-image"
        self.progress({"id": "local-private-id", "owner": "private", "status": "running", "path": "/private/secret"})
        return b"\x89PNG\r\n\x1a\nresult", "result.png", "image/png", {}


def execute(case, service=Service, role="toonout"):
    storage, payload, _, scratch = case
    return run_service_job(payload, client=storage, service_factory=service, scratch=scratch, role=role)


def test_result_published_after_service_exit_and_scratch_cleanup(case):
    storage, _, prefix, scratch = case
    original = storage.put_object
    services = []

    class Tracked(Service):
        def __init__(self, *args):
            super().__init__(*args)
            services.append(self)

    def put(**kwargs):
        if kwargs["Key"] == prefix + "result.json":
            assert services[0].closed
            assert list(scratch.iterdir()) == []
        original(**kwargs)
    storage.put_object = put
    assert execute(case, Tracked)["status"] == "completed"
    assert storage.files[prefix + "result.png"].startswith(b"\x89PNG")
    progress = json.loads(storage.files[prefix + "progress.json"])
    assert progress["id"] == "job_" + "b" * 32
    assert "owner" not in progress and "path" not in progress
    # A duplicate completed delivery does no additional work.
    assert execute(case, lambda *_: pytest.fail("duplicate GPU work"))["status"] == "completed"


def test_running_cancellation_waits_for_service_exit(case):
    storage, _, prefix, scratch = case
    closed = []

    class Cancelling(Service):
        def run(self, *_):
            storage.files[prefix + "cancel.json"] = b"{}"
            self.check()
        def __exit__(self, *_):
            closed.append(True)
    assert execute(case, Cancelling)["status"] == "cancelled"
    assert closed == [True]
    assert list(scratch.iterdir()) == []
    assert prefix + "result.png" not in storage.files


def test_cancel_before_start_avoids_loading_models(case):
    storage, _, prefix, _ = case
    storage.files[prefix + "cancel.json"] = b"{}"
    assert execute(case, lambda *_: pytest.fail("model started"))["status"] == "cancelled"


def test_concurrent_duplicate_delivery_cannot_replace_original_receipt(case):
    storage, _, prefix, _ = case
    original_put = storage.put_object
    storage.files[prefix + "worker.json"] = b'{"runId":"original-run"}'
    storage.files[prefix + "receipt.json"] = b'{"runId":"original-run"}'

    def put(**kwargs):
        if kwargs.get("IfNoneMatch") == "*" and kwargs["Key"] in storage.files:
            error = RuntimeError("conditional conflict")
            error.response = {"Error": {"Code": "PreconditionFailed"}}
            raise error
        original_put(**kwargs)
    storage.put_object = put
    assert execute(case, lambda *_: pytest.fail("duplicate model work"))["status"] == "duplicate"
    assert json.loads(storage.files[prefix + "receipt.json"])["runId"] == "original-run"


def test_upstream_failure_is_sanitized_and_cleans_local_files(case):
    storage, _, prefix, scratch = case
    class Failing(Service):
        def run(self, *_):
            raise RuntimeError("secret-token local-path /private")
    assert execute(case, Failing)["status"] == "failed"
    assert b"secret-token" not in storage.files[prefix + "result.json"]
    assert list(scratch.iterdir()) == []


@pytest.mark.parametrize("change", ["owner", "key", "digest", "expired", "role"])
def test_foreign_inputs_and_expiry_cannot_start_a_model(case, change):
    storage, payload, prefix, _ = case
    key = payload["input"]["manifest_key"]
    manifest = json.loads(storage.files[key])
    if change == "owner":
        manifest["owner"] = "anon_" + "f" * 32
    if change == "key":
        manifest["files"][0]["key"] = "movie-temp/another-owner/input"
    if change == "digest":
        storage.files[manifest["files"][0]["key"]] = b"wrong-image"
    if change == "expired":
        manifest["expires"] = 0
    storage.files[key] = json.dumps(manifest).encode()
    if change in {"owner", "role"}:
        with pytest.raises(ValueError):
            execute(case, lambda *_: pytest.fail("model started"), role="voice" if change == "role" else "toonout")
    else:
        result = execute(case, lambda *_: pytest.fail("model started"))
        assert result["status"] == ("cancelled" if change == "expired" else "failed")
