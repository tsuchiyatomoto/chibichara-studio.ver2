"""Owner-scoped diagnostics for Gemini audio requests, without request payloads."""

import json
import logging
import os
import re
import time
import uuid
from collections import OrderedDict
from datetime import datetime, timezone

from . import config

LOG_NAME = "audio-analysis.jsonl"
TIMEOUT_MS = 120000
logger = logging.getLogger(__name__)
RESPONSE_HEADERS = {"x-request-id", "x-goog-request-id", "x-cloud-trace-context",
                    "retry-after", "server-timing", "date"}


def redact(value):
    if isinstance(value, dict):
        return {key: "[REDACTED]" if re.search(
            r"authorization|api[_-]?key|token|secret|credential|private[_-]?key", key, re.I
        ) else redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        for name in ("GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "MOVIE_WORKER_TOKEN"):
            secret = os.environ.get(name)
            if secret:
                value = value.replace(secret, "[REDACTED]")
        return re.sub(r"(?i)\bBearer\s+[^\s\"'<>]+", "Bearer [REDACTED]", value)
    return value


def error_details(exc):
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", {}) or {}
    return redact(dict(
        type=type(exc).__name__, code=getattr(exc, "code", None),
        status=getattr(exc, "status", None), message=getattr(exc, "message", None) or str(exc),
        body=getattr(exc, "details", None),
        response_headers={key.lower(): value for key, value in headers.items()
                          if key.lower() in RESPONSE_HEADERS},
    ))


class RequestLog:
    def __init__(self, directory, *, operation, window_start, window_end,
                 audio_start, audio_end, max_attempts, **extra):
        self.path = directory / LOG_NAME
        self.context = dict(
            job_id=directory.name, operation=operation,
            window_start=round(window_start, 6), window_end=round(window_end, 6),
            audio_start=round(audio_start, 6), audio_end=round(audio_end, 6),
            audio_duration_seconds=round(audio_end - audio_start, 6),
            model=config.GEMINI_MODEL, location=os.environ.get("GOOGLE_CLOUD_LOCATION", "global"),
            timeout_ms=TIMEOUT_MS, max_attempts=max_attempts,
            group_id=uuid.uuid4().hex, **extra,
        )
        self.attempt = 0

    def record(self, record):
        record = dict(self.context, event="audio_analysis_request",
                      timestamp=datetime.now(timezone.utc).isoformat(), **record)
        line = json.dumps(record, ensure_ascii=False)
        try:
            with self.path.open("a", encoding="utf-8") as file:
                file.write(line + "\n")
        except OSError:
            # Diagnostic storage must not turn an otherwise successful request into a failure.
            logger.warning("Could not write audio diagnostics for job %s", self.context["job_id"])
        if record["outcome"] == "failed":
            logger.warning(line)

    def generate_content(self, client, **kwargs):
        self.attempt += 1
        record = dict(request_id=uuid.uuid4().hex, attempt=self.attempt,
                      audio_bytes=sum(len(part.inline_data.data)
                                      for content in kwargs["contents"] for part in content.parts
                                      if part.inline_data and part.inline_data.data))
        self.record(dict(record, outcome="started"))
        started = time.monotonic()
        try:
            response = client.models.generate_content(**kwargs)
        except Exception as exc:
            self.record(dict(record, outcome="failed", elapsed_ms=round((time.monotonic() - started) * 1000),
                             error=error_details(exc)))
            raise
        self.record(dict(record, outcome="succeeded", elapsed_ms=round((time.monotonic() - started) * 1000),
                         response_id=getattr(response, "response_id", None)))
        return response


def generate_content(client, diagnostics, **kwargs):
    if diagnostics is None:
        return client.models.generate_content(**kwargs)
    return diagnostics.generate_content(client, **kwargs)


def read_recent(directory, limit=100):
    """Keep the latest state of each attempt; tolerate an in-progress final line."""
    records = OrderedDict()
    truncated = False
    try:
        with (directory / LOG_NAME).open(encoding="utf-8") as file:
            for line in file:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(record, dict) or not isinstance(record.get("request_id"), str):
                    continue
                records[record["request_id"]] = record
                if len(records) > limit:
                    records.popitem(last=False)
                    truncated = True
    except FileNotFoundError:
        return dict(available=False, entries=[], truncated=False)
    return dict(available=True, entries=list(reversed(records.values())), truncated=truncated)
