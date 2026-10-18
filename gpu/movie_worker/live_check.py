"""Explicit opt-in live integration check. Calls paid Gemini and local Irodori.

python -m movie_worker.live_check --audio PATH --speaker PATH
Uses a separate test owner; never changes the browser's saved voice.
"""

import argparse
import json
import time
import uuid
from pathlib import Path

import httpx

from . import config, media
from .pipeline import Engine, tts_headers
from .store import Store


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--speaker", type=Path, required=True)
    args = parser.parse_args()
    root = config.DATA / ("live-check-" + uuid.uuid4().hex[:8])
    store = Store(root)
    owner = "anon_" + uuid.uuid4().hex
    headers = tts_headers(owner)
    response = httpx.post(
        config.TTS + "/v1/audio/speaker-assets",
        headers=headers,
        data={"name": "Movie integration check"},
        files={
            "file": (
                "check.speaker.safetensors",
                args.speaker.read_bytes(),
                "application/octet-stream",
            )
        },
        timeout=30,
    )
    response.raise_for_status()
    asset = response.json()["id"]
    try:
        duration = float(media.probe(args.audio)["format"]["duration"])
        job = store.create(owner, "live-check.mp4", 1)
        ident = job["id"]
        directory = store.directory(ident)
        media.ffmpeg(
            [
                "-f",
                "lavfi",
                "-i",
                f"color=c=blue:s=320x180:r=15:d={duration}",
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency=440:sample_rate=48000:duration={duration}",
                "-i",
                args.audio,
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-map",
                "2:a",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                "-t",
                str(duration),
                directory / "input.mp4",
            ]
        )
        engine = Engine(store)
        started = time.monotonic()
        print("LIVE_CHECK_DIRECTORY", str(directory), flush=True)
        store.patch(ident, state="queued")
        engine.perform(ident, "inspect")
        engine.perform(ident, "analyze")
        result = store.get(ident)
        print(
            "PREVIEW_RESULT",
            json.dumps(
                {"state": result["state"], "segments": result["segments"]},
                ensure_ascii=False,
            ),
            flush=True,
        )
        print("ELAPSED_SECONDS", round(time.monotonic() - started, 2), flush=True)
        # A live check deliberately stops at the same audition gate as the UI.
        # Do not certify timbre/noise using a numerical check or override review.
    finally:
        httpx.delete(
            config.TTS + f"/v1/audio/voice-assets/{asset}", headers=headers, timeout=30
        ).raise_for_status()


if __name__ == "__main__":
    main()
