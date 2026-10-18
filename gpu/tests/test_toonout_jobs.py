import base64
import os
import threading
import time

import pytest
from fastapi.testclient import TestClient

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XxKqWQAAAABJRU5ErkJggg==")
OWNER = "anon_" + "a" * 32


def wait_status(client, ident, status):
    for _ in range(250):
        response = client.get(f"/jobs/{ident}")
        if response.json()["status"] == status:
            return
        time.sleep(0.01)
    pytest.fail(response.text)


@pytest.fixture
def setup(monkeypatch, tmp_path):
    from toonout_worker import server

    release = threading.Event()
    entered = threading.Event()
    calls = []

    class Processor:
        device = "cpu"

        def remove(self, data):
            calls.append(data)
            entered.set()
            assert release.wait(120)
            return PNG

    monkeypatch.setattr(server.config, "DATA", tmp_path)
    monkeypatch.setattr(server, "ToonOut", Processor)
    headers = {"Authorization": "Bearer " + server.TOKEN,
               "X-Job-Owner": OWNER, "Idempotency-Key": "image_request_" + "a" * 20,
               "Content-Type": "image/png"}
    with TestClient(server.app, headers=headers) as client:
        try:
            yield client, release, entered, calls
        finally:
            release.set()


def test_background_job_accepts_without_waiting_and_downloads_after_completion(setup):
    client, release, entered, calls = setup
    started = time.monotonic()
    accepted = client.post("/jobs", content=PNG)
    assert accepted.status_code == 202, accepted.text
    assert time.monotonic() - started < 1
    ident = accepted.json()["id"]
    assert entered.wait(3)
    assert client.get(f"/jobs/{ident}").json()["status"] == "running"
    assert client.post("/jobs", content=PNG).json()["id"] == ident
    assert client.get(f"/jobs/{ident}/content").status_code == 409
    assert client.get(f"/jobs/{ident}", headers={"X-Job-Owner": "anon_" + "b" * 32}).status_code == 404
    release.set()
    wait_status(client, ident, "completed")
    assert client.get(f"/jobs/{ident}/content").content == PNG
    assert calls == [PNG]


def test_cancelled_inference_finishes_before_job_is_released(setup):
    client, release, entered, _calls = setup
    ident = client.post("/jobs", content=PNG).json()["id"]
    assert entered.wait(3)
    assert client.delete(f"/jobs/{ident}").json()["status"] == "cancelling"
    release.set()
    wait_status(client, ident, "cancelled")
    assert client.get(f"/jobs/{ident}/content").status_code == 409


def test_job_submission_requires_valid_owner_key_and_media(setup):
    client, _release, _entered, _calls = setup
    assert client.post("/jobs", content=PNG, headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.post("/jobs", content=PNG, headers={"X-Job-Owner": "wrong"}).status_code == 400
    assert client.post("/jobs", content=PNG, headers={"Idempotency-Key": "wrong"}).status_code == 400
    assert client.post("/jobs", content=PNG, headers={"Content-Type": "text/plain"}).status_code == 415


@pytest.mark.skipif(os.environ.get("LONG_JOB_TEST") != "1", reason="101-second HTTP acceptance test")
def test_processing_over_100_seconds_keeps_http_requests_short(setup):
    client, release, entered, _calls = setup
    accepted = client.post("/jobs", content=PNG)
    assert accepted.status_code == 202
    ident = accepted.json()["id"]
    assert entered.wait(3)
    started = time.monotonic()
    while time.monotonic() - started < 101:
        before = time.monotonic()
        response = client.get(f"/jobs/{ident}")
        assert response.json()["status"] == "running"
        assert time.monotonic() - before < 1
        time.sleep(1)
    release.set()
    wait_status(client, ident, "completed")
    assert client.get(f"/jobs/{ident}/content").content == PNG
