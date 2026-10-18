import threading
import time
from pathlib import Path

import pytest
import torch
from fastapi.testclient import TestClient
from test_api import FakeRuntime, FakeRuntimeManager

from irodori_openai_tts import app as main
from irodori_openai_tts.workload import WorkloadGate

OWNER = "anon_" + "c" * 32
OTHER = "anon_" + "d" * 32
HEADERS = {"X-Irodori-Owner-ID": OWNER, "Idempotency-Key": "request_" + "1" * 24}
BODY = {"model": "irodori-tts", "input": "こんにちは", "voice": "none", "response_format": "wav"}


def status_until(client, ident, status):
    for _ in range(200):
        response = client.get(f"/v1/audio/speech-jobs/{ident}", headers=HEADERS)
        if response.json()["status"] == status:
            return response.json()
        time.sleep(0.01)
    pytest.fail(response.text)


def test_job_http_calls_remain_short_while_inference_is_blocked(monkeypatch):
    release = threading.Event()
    started = threading.Event()

    class BlockingRuntime(FakeRuntime):
        def synthesize(self, request, *, log_fn=None):
            started.set()
            assert release.wait(10)
            return super().synthesize(request, log_fn=log_fn)

    runtime = BlockingRuntime()
    monkeypatch.setattr(main, "runtime_manager", FakeRuntimeManager(runtime))
    monkeypatch.setattr(main, "startup", lambda: None)
    monkeypatch.setattr(main, "workload_gate", WorkloadGate())
    with TestClient(main.app) as client:
        try:
            before = time.monotonic()
            accepted = client.post("/v1/audio/speech-jobs", json=BODY, headers=HEADERS)
            assert accepted.status_code == 202, accepted.text
            assert time.monotonic() - before < 1
            ident = accepted.json()["id"]
            assert client.post("/v1/audio/speech-jobs", json=BODY, headers=HEADERS).json()["id"] == ident
            assert started.wait(3)
            assert client.get(f"/v1/audio/speech-jobs/{ident}", headers=HEADERS).json()["status"] == "running"
            for suffix in ("", "/content"):
                assert client.get(f"/v1/audio/speech-jobs/{ident}{suffix}", headers={"X-Irodori-Owner-ID": OTHER}).status_code == 404
            assert client.get(f"/v1/audio/speech-jobs/{ident}/content", headers=HEADERS).status_code == 409
            release.set()
            status_until(client, ident, "completed")
            result = client.get(f"/v1/audio/speech-jobs/{ident}/content", headers=HEADERS)
            assert result.status_code == 200 and result.content.startswith(b"RIFF")
            assert len(runtime.requests) == 1
            assert main.workload_gate.snapshot().active_inferences == 0
        finally:
            release.set()


def test_job_waits_for_training_and_cancel_does_not_enter_inference(monkeypatch):
    runtime = FakeRuntime()
    gate = WorkloadGate()
    gate.reserve_training()
    monkeypatch.setattr(main, "runtime_manager", FakeRuntimeManager(runtime))
    monkeypatch.setattr(main, "startup", lambda: None)
    monkeypatch.setattr(main, "workload_gate", gate)
    with TestClient(main.app) as client:
        response = client.post("/v1/audio/speech-jobs", json=BODY, headers=HEADERS)
        assert response.status_code == 202, response.text
        ident = response.json()["id"]
        status_until(client, ident, "running")
        assert runtime.requests == []
        client.delete(f"/v1/audio/speech-jobs/{ident}", headers=HEADERS)
        status_until(client, ident, "cancelled")
        assert runtime.requests == []
    gate.cancel_training_reservation()


def test_queued_voice_reference_survives_asset_deletion_and_retry(monkeypatch):
    wave = main.encode_audio(torch.zeros(1, 100), 1000, "wav")
    observed = []

    class ReadingRuntime(FakeRuntime):
        def synthesize(self, request, *, log_fn=None):
            observed.append(Path(request.ref_wav).read_bytes())
            return super().synthesize(request, log_fn=log_fn)

    gate = WorkloadGate()
    gate.reserve_training()
    monkeypatch.setattr(main, "runtime_manager", FakeRuntimeManager(ReadingRuntime()))
    monkeypatch.setattr(main, "startup", lambda: None)
    monkeypatch.setattr(main, "workload_gate", gate)
    asset = main.voice_asset_store.create_temporary_reference(owner_id=OWNER, filename="reference.wav", data=wave)
    body = {**BODY, "voice_asset_id": asset.id}
    with TestClient(main.app) as client:
        try:
            response = client.post("/v1/audio/speech-jobs", json=body, headers=HEADERS)
            assert response.status_code == 202, response.text
            ident = response.json()["id"]
            assert client.delete(f"/v1/audio/voice-assets/{asset.id}", headers=HEADERS).status_code in {200, 204}
            retry = client.post("/v1/audio/speech-jobs", json=body, headers=HEADERS)
            assert retry.status_code == 202 and retry.json()["id"] == ident
            gate.cancel_training_reservation()
            status_until(client, ident, "completed")
            assert observed == [wave]
        finally:
            if gate.snapshot().training_reserved:
                gate.cancel_training_reservation()
