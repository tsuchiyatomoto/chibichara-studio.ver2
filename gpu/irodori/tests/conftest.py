from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from irodori_openai_tts import app as main


@pytest.fixture(autouse=True)
def restore_app_globals(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "speech_jobs", None)
    monkeypatch.setattr(main.settings, "speech_jobs_dir", tmp_path / "speech-jobs")
    monkeypatch.setattr(main.settings, "api_key", None)
    monkeypatch.setattr(main.settings, "voices_dir", tmp_path)
    monkeypatch.setattr(main.settings, "voice_assets_dir", tmp_path / "voice-assets")
    monkeypatch.setattr(
        main.settings,
        "speaker_inversion_jobs_dir",
        tmp_path / "speaker-inversion-jobs",
    )
    monkeypatch.setattr(main.settings, "voice_aliases_file", None)
    monkeypatch.setattr(main.settings, "default_voice", None)
    monkeypatch.setattr(main.settings, "allow_no_ref_voice", True)
    monkeypatch.setattr(main.settings, "default_chunking_enabled", True)
    monkeypatch.setattr(main.settings, "default_chunk_min_chars", 80)
    monkeypatch.setattr(main.settings, "default_first_sentence_chunk_min_chars", None)
    monkeypatch.setattr(main.settings, "max_concurrent_synthesis", 1)
    monkeypatch.setattr(main.settings, "synthesis_wait_timeout", 300.0)
    monkeypatch.setattr(main, "_synthesis_semaphore", None)
    monkeypatch.setattr(main, "_synthesis_semaphore_limit", None)
    yield
