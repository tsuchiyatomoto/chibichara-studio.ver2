from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
import torch
from safetensors.torch import save

from irodori_openai_tts.config import Settings
from irodori_openai_tts.speaker_inversion_jobs import (
    SpeakerInversionJobManager,
    SpeakerInversionNotFoundError,
)
from irodori_openai_tts.voice_assets import VoiceAssetStore
from irodori_openai_tts.voices import SPEAKER_INVERSION_SUFFIX, VoiceRegistry
from irodori_openai_tts.workload import WorkloadGate


class FakeRuntimeManager:
    def __init__(self, checkpoint: Path) -> None:
        self.checkpoint = checkpoint
        self.unloaded = False

    def resolve_checkpoint_path(self) -> str:
        return str(self.checkpoint)

    def unload(self) -> None:
        self.unloaded = True


def wait_for_terminal_job(
    manager: SpeakerInversionJobManager,
    job_id: str,
    owner_id: str = "owner-one",
) -> dict:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        job = manager.get(job_id, owner_id)
        if job["status"] not in {"queued", "running", "cancelling"}:
            return job
        time.sleep(0.01)
    raise AssertionError("Speaker Inversion job did not finish.")


def test_job_keeps_temporary_result_until_explicit_owner_save(tmp_path, monkeypatch) -> None:
    training_root = tmp_path / "Irodori-TTS"
    (training_root / "configs").mkdir(parents=True)
    (training_root / "train.py").write_text("", encoding="utf-8")
    (training_root / "configs" / "train_v4_small_speaker_inversion.yaml").write_text(
        "train: {}\n",
        encoding="utf-8",
    )
    checkpoint = tmp_path / "model.safetensors"
    checkpoint.write_bytes(b"base")
    settings = Settings(
        checkpoint=str(checkpoint),
        voices_dir=tmp_path / "voices",
        voice_assets_dir=tmp_path / "voice-assets",
        speaker_inversion_training_root=training_root,
        speaker_inversion_jobs_dir=tmp_path / "jobs",
        speaker_inversion_max_steps=3,
        _env_file=None,
    )
    runtime = FakeRuntimeManager(checkpoint)
    registry = VoiceRegistry(settings)
    assets = VoiceAssetStore(settings)
    gate = WorkloadGate()
    manager = SpeakerInversionJobManager(settings, runtime, assets, gate)  # type: ignore[arg-type]
    speaker_bytes = save({"speaker_embedding": torch.zeros(16, 768)})

    def fake_run_process(job_id, _command, _cancel_event, *, phase):
        if phase == "training":
            output = manager._job_dir(job_id) / "output"
            output.mkdir(parents=True, exist_ok=True)
            (output / f"checkpoint_final{SPEAKER_INVERSION_SUFFIX}").write_bytes(
                speaker_bytes
            )

    monkeypatch.setattr(manager, "_run_process", fake_run_process)
    samples = [("sample.wav", b"RIFF", f"text {index}", "calm") for index in range(5)]

    created = manager.create(owner_id="owner-one", voice_id="alice", samples=samples)
    completed = wait_for_terminal_job(manager, created["id"])

    assert completed["status"] == "completed"
    assert completed["progress"] == {"current": 3, "total": 3, "ratio": 1.0}
    assert runtime.unloaded
    result = manager.result_path(created["id"], "owner-one")
    assert result.read_bytes() == speaker_bytes
    assert registry.get_file("alice") is None
    assert completed["result"]["registered"] is False
    assert completed["result"]["saved"] is False
    with pytest.raises(SpeakerInversionNotFoundError):
        manager.result_path(created["id"], "owner-two")

    saved = manager.save_result(created["id"], "owner-one")

    assert saved["id"].startswith("vasset_")
    assert assets.resolve("owner-one", saved["id"]).ref_embed is not None
    assert manager.get(created["id"], "owner-one")["result"]["saved"] is True
    assert gate.try_enter_inference()
    gate.leave_inference()
    manager.shutdown()
    assets.shutdown()


def test_readiness_rejects_invalid_explicit_training_root(tmp_path) -> None:
    settings = Settings(
        voices_dir=tmp_path / "voices",
        voice_assets_dir=tmp_path / "voice-assets",
        speaker_inversion_jobs_dir=tmp_path / "jobs",
        speaker_inversion_training_root=tmp_path / "missing",
        _env_file=None,
    )
    manager = SpeakerInversionJobManager(
        settings,
        FakeRuntimeManager(tmp_path / "model.safetensors"),  # type: ignore[arg-type]
        VoiceAssetStore(settings),
        WorkloadGate(),
    )

    readiness = manager.readiness()

    assert readiness["ready"] is False
    assert "IRODORI_SPEAKER_INVERSION_TRAINING_ROOT is invalid" in readiness["reason"]


def test_running_job_can_be_cancelled(tmp_path, monkeypatch) -> None:
    training_root = tmp_path / "Irodori-TTS"
    (training_root / "configs").mkdir(parents=True)
    (training_root / "train.py").write_text("", encoding="utf-8")
    (training_root / "configs" / "train_v4_small_speaker_inversion.yaml").write_text(
        "train: {}\n",
        encoding="utf-8",
    )
    checkpoint = tmp_path / "model.safetensors"
    checkpoint.write_bytes(b"base")
    settings = Settings(
        checkpoint=str(checkpoint),
        voices_dir=tmp_path / "voices",
        voice_assets_dir=tmp_path / "voice-assets",
        speaker_inversion_training_root=training_root,
        speaker_inversion_jobs_dir=tmp_path / "jobs",
        _env_file=None,
    )
    manager = SpeakerInversionJobManager(
        settings,
        FakeRuntimeManager(checkpoint),  # type: ignore[arg-type]
        VoiceAssetStore(settings),
        WorkloadGate(),
    )
    process_started = threading.Event()

    def fake_run_process(_job_id, _command, cancel_event, *, phase):
        process_started.set()
        assert phase == "preparing"
        assert cancel_event.wait(timeout=1)

    monkeypatch.setattr(manager, "_run_process", fake_run_process)
    samples = [("sample.wav", b"RIFF", f"text {index}", "calm") for index in range(5)]
    created = manager.create(owner_id="owner-one", voice_id="alice", samples=samples)
    assert process_started.wait(timeout=1)

    cancelling = manager.cancel(created["id"], "owner-one")
    cancelled = wait_for_terminal_job(manager, created["id"])

    assert cancelling["status"] in {"cancelling", "cancelled"}
    assert cancelled["status"] == "cancelled"
    assert manager.workload_gate.snapshot().training_reserved is False
    manager.shutdown()
