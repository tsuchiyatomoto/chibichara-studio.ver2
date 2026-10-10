import json
from types import SimpleNamespace

import httpx
import pytest
from google.genai import errors

from movie_worker import audio_diagnostics as diagnostics, audio_events


def request_log(directory):
    return diagnostics.RequestLog(
        directory, operation="events", window_start=808.5, window_end=838.3,
        audio_start=810, audio_end=836.708, max_attempts=3)


def deadline():
    return errors.ServerError(504, {"error": {"code": 504, "status": "DEADLINE_EXCEEDED",
                                              "message": "Deadline expired before operation could complete."}},
                              response=httpx.Response(504, headers={"x-request-id": "google-request-1",
                                                                    "set-cookie": "private-cookie"}))


def unavailable():
    return errors.ServerError(503, {"error": {"code": 503, "status": "UNAVAILABLE",
                                              "message": "Temporarily unavailable."}},
                              response=httpx.Response(503, headers={"x-request-id": "google-request-1",
                                                                    "set-cookie": "private-cookie"}))


def test_records_retryable_failures_even_if_a_retry_succeeds(tmp_path, monkeypatch):
    clock = iter([0, 119.2, 124.2, 244.2, 254.2, 256.5])
    monkeypatch.setattr(diagnostics.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(audio_events.time, "sleep", lambda _: None)
    calls = []
    def generate(**kwargs):
        calls.append(kwargs)
        if len(calls) < 3:
            raise unavailable()
        return SimpleNamespace(candidates=[SimpleNamespace(finish_reason="STOP")],
                               text='{"audio_understood":true,"reason":"","events":[]}',
                               usage_metadata=None, response_id="response-3")
    client = SimpleNamespace(models=SimpleNamespace(generate_content=generate))
    audio_events.request_events(client, b"private-audio-bytes", 26.708, lambda: None, request_log(tmp_path))
    log = diagnostics.read_recent(tmp_path)
    entries = log["entries"]
    assert [e["outcome"] for e in entries] == ["succeeded", "failed", "failed"]
    assert [e["elapsed_ms"] for e in entries] == [2300, 120000, 119200]
    assert [e["attempt"] for e in entries] == [3, 2, 1]
    assert len({e["group_id"] for e in entries}) == 1
    assert entries[1]["error"]["body"] == unavailable().details
    assert entries[1]["error"]["response_headers"] == {"x-request-id": "google-request-1"}
    assert entries[1]["timeout_ms"] == 120000 and entries[1]["audio_duration_seconds"] == 26.708
    saved = (tmp_path / diagnostics.LOG_NAME).read_text(encoding="utf-8")
    assert len(saved.splitlines()) == 6  # Starts survive even if the worker is interrupted.
    assert "private-audio-bytes" not in saved and "private-cookie" not in saved
    assert all(call["contents"][0].parts[0].inline_data.data == b"private-audio-bytes" for call in calls)


def test_deadline_is_returned_immediately_so_the_caller_can_change_audio(tmp_path, monkeypatch):
    monkeypatch.setattr(audio_events.time, "sleep", lambda _: None)
    exc = deadline()
    def fail(**kwargs):
        raise exc
    client = SimpleNamespace(models=SimpleNamespace(generate_content=fail))
    for _ in range(2):
        with pytest.raises(errors.ServerError) as caught:
            audio_events.request_events(client, b"audio", 26.708, lambda: None, request_log(tmp_path))
        assert caught.value is exc
    entries = diagnostics.read_recent(tmp_path)["entries"]
    assert len(entries) == 2
    assert all(e["outcome"] == "failed" for e in entries)
    assert len({e["group_id"] for e in entries}) == 2
    assert all(e["attempt"] == 1 for e in entries)


def test_transport_timeout_is_distinguished_from_google_504(tmp_path):
    def fail(**kwargs):
        raise httpx.ReadTimeout("read timed out")
    client = SimpleNamespace(models=SimpleNamespace(generate_content=fail))
    with pytest.raises(httpx.ReadTimeout):
        audio_events.request_events(client, b"audio", 26.708, lambda: None, request_log(tmp_path))
    entry = diagnostics.read_recent(tmp_path)["entries"][0]
    assert entry["error"]["type"] == "ReadTimeout"
    assert entry["error"]["code"] is None


def test_recent_log_is_bounded_and_tolerates_incomplete_last_line(tmp_path):
    path = tmp_path / diagnostics.LOG_NAME
    assert not diagnostics.read_recent(tmp_path)["available"]
    records = []
    for i in range(105):
        records.extend([dict(request_id=str(i), outcome="started"),
                        dict(request_id=str(i), outcome="succeeded")])
    path.write_text("\n".join(map(json.dumps, records)) + '\n{"request_id":', encoding="utf-8")
    log = diagnostics.read_recent(tmp_path)
    assert log["available"] and log["truncated"]
    assert len(log["entries"]) == 100
    assert log["entries"][0]["request_id"] == "104" and log["entries"][-1]["request_id"] == "5"


def test_error_details_redact_credentials(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "example-secret-key")
    exc = errors.ClientError(403, {"error": {"message": "example-secret-key Bearer private-token",
                                             "metadata": {"api_key": "hidden", "access_token": "hidden"}}})
    result = json.dumps(diagnostics.error_details(exc))
    assert "example-secret-key" not in result and "private-token" not in result
    # The structured response fields are redacted, too.
    assert diagnostics.error_details(exc)["body"]["error"]["metadata"]["api_key"] == "[REDACTED]"


def test_log_write_failure_does_not_replace_google_error(tmp_path):
    log = request_log(tmp_path / "missing-directory")
    exc = deadline()
    def fail(**kwargs):
        raise exc
    with pytest.raises(errors.ServerError) as caught:
        log.generate_content(SimpleNamespace(models=SimpleNamespace(generate_content=fail)), contents=[])
    assert caught.value is exc
