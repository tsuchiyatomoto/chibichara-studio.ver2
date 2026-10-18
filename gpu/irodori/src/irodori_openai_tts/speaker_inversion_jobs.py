from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from irodori_tts.inference_runtime import default_runtime_device

from .config import Settings
from .runtime import RuntimeManager
from .voice_assets import VoiceAssetNotFoundError, VoiceAssetStore
from .voices import SPEAKER_INVERSION_SUFFIX, VOICE_EXTENSIONS
from .workload import TrainingAlreadyReservedError, WorkloadGate

logger = logging.getLogger(__name__)
ACTIVE_STATUSES = frozenset({"queued", "running", "cancelling"})
TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})
EVENT_PREFIX = "IRODORI_SPEAKER_EVENT "
STEP_PATTERN = re.compile(r"\bstep=(\d+)\b")


class SpeakerInversionNotReadyError(RuntimeError):
    pass


class SpeakerInversionBusyError(RuntimeError):
    pass


class SpeakerInversionNotFoundError(KeyError):
    pass


class SpeakerInversionResultNotReadyError(RuntimeError):
    pass


class _JobCancelledError(RuntimeError):
    pass


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class SpeakerInversionJob:
    id: str
    voice_id: str
    status: str
    phase: str
    sample_count: int
    created_at: str
    updated_at: str
    progress_current: int = 0
    progress_total: int = 0
    message: str = ""
    error: str | None = None
    result_filename: str | None = None
    replace: bool = False
    cancellation_requested: bool = False
    owner_id: str = "legacy"
    expires_at: str | None = None
    saved_asset_id: str | None = None

    def api_dict(self) -> dict[str, Any]:
        progress = 0.0
        if self.progress_total > 0:
            progress = min(1.0, self.progress_current / self.progress_total)
        return {
            "id": self.id,
            "object": "speaker_inversion_job",
            "voice_id": self.voice_id,
            "status": self.status,
            "phase": self.phase,
            "sample_count": self.sample_count,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "progress": {
                "current": self.progress_current,
                "total": self.progress_total,
                "ratio": progress,
            },
            "message": self.message,
            "error": self.error,
            "result": (
                None
                if self.result_filename is None
                else {
                    "filename": _result_download_filename(self.voice_id),
                    "voice_id": self.voice_id,
                    "download_url": f"/v1/audio/speaker-inversions/{self.id}/result",
                    "registered": False,
                    "saved": self.saved_asset_id is not None,
                    "saved_asset_id": self.saved_asset_id,
                    "expires_at": self.expires_at,
                }
            ),
            "cancellation_requested": self.cancellation_requested,
        }


class SpeakerInversionJobManager:
    def __init__(
        self,
        settings: Settings,
        runtime_manager: RuntimeManager,
        voice_asset_store: VoiceAssetStore,
        workload_gate: WorkloadGate,
    ) -> None:
        self.settings = settings
        self.runtime_manager = runtime_manager
        self.voice_asset_store = voice_asset_store
        self.workload_gate = workload_gate
        self._lock = threading.RLock()
        self._jobs: dict[str, SpeakerInversionJob] = {}
        self._cancel_events: dict[str, threading.Event] = {}
        self._processes: dict[str, subprocess.Popen[str]] = {}
        self._futures: dict[str, Future[None]] = {}
        self._executor: ThreadPoolExecutor | None = None
        self._active_job_id: str | None = None
        self._loaded_root: Path | None = None
        self._cleanup_event = threading.Event()
        self._cleanup_thread: threading.Thread | None = None

    def startup(self) -> None:
        root = self._jobs_root()
        with self._lock:
            if self._loaded_root == root and self._executor is not None:
                return
            if self._active_job_id is not None:
                raise RuntimeError(
                    "Cannot switch Speaker Inversion job roots while a job is active."
                )
            root.mkdir(parents=True, exist_ok=True)
            self._jobs = {}
            for state_path in sorted(root.glob("*/state.json")):
                try:
                    raw = json.loads(state_path.read_text(encoding="utf-8"))
                    raw.setdefault("owner_id", "legacy")
                    raw.setdefault("expires_at", None)
                    raw.setdefault("saved_asset_id", None)
                    job = SpeakerInversionJob(**raw)
                except Exception:
                    logger.exception("failed to load Speaker Inversion state: %s", state_path)
                    continue
                if job.status in ACTIVE_STATUSES:
                    job.status = "failed"
                    job.phase = "interrupted"
                    job.error = "The TTS server stopped before this job completed."
                    job.message = "Training was interrupted by a server restart."
                    job.updated_at = _utc_now()
                    job.expires_at = self._expiration_from(job.updated_at)
                    self._write_state(job)
                elif job.expires_at is None and job.status not in ACTIVE_STATUSES:
                    job.expires_at = self._expiration_from(job.updated_at)
                    self._write_state(job)
                self._jobs[job.id] = job
            self._cleanup_expired_jobs_locked()
            self._executor = ThreadPoolExecutor(
                max_workers=1,
                thread_name_prefix="speaker-inversion",
            )
            self._cleanup_event = threading.Event()
            self._cleanup_thread = threading.Thread(
                target=self._cleanup_loop,
                name="speaker-inversion-cleanup",
                daemon=True,
            )
            self._cleanup_thread.start()
            self._loaded_root = root

    def shutdown(self) -> None:
        with self._lock:
            active_job_id = self._active_job_id
            active_owner_id = (
                None if active_job_id is None else self._jobs[active_job_id].owner_id
            )
            executor = self._executor
            cleanup_thread = self._cleanup_thread
            self._cleanup_thread = None
            self._cleanup_event.set()
        if active_job_id is not None and active_owner_id is not None:
            try:
                self.cancel(active_job_id, active_owner_id)
            except SpeakerInversionNotFoundError:
                pass
        with self._lock:
            self._executor = None
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=True)
        if cleanup_thread is not None:
            cleanup_thread.join(timeout=2)

    def readiness(self) -> dict[str, Any]:
        training_root, reason = self._resolve_training_root()
        state = self.workload_gate.snapshot()
        return {
            "enabled": bool(self.settings.speaker_inversion_enabled),
            "ready": bool(self.settings.speaker_inversion_enabled and training_root is not None),
            "reason": reason,
            "training_root": None if training_root is None else str(training_root),
            "jobs_dir": str(self._jobs_root()),
            "min_samples": max(1, int(self.settings.speaker_inversion_min_samples)),
            "max_samples": max(1, int(self.settings.speaker_inversion_max_samples)),
            "max_steps": max(1, int(self.settings.speaker_inversion_max_steps)),
            "result_ttl_hours": max(
                0.0, float(self.settings.speaker_inversion_result_ttl_hours)
            ),
            "busy": state.training_reserved,
            "training": state.training_active,
            "active_job_id": self._active_job_id,
        }

    def create(
        self,
        *,
        owner_id: str,
        voice_id: str,
        samples: list[tuple[str, bytes, str, str]],
        replace: bool = False,
    ) -> dict[str, Any]:
        self.startup()
        if not self.settings.speaker_inversion_enabled:
            raise SpeakerInversionNotReadyError("Speaker Inversion is disabled on this server.")
        training_root, reason = self._resolve_training_root()
        if training_root is None:
            raise SpeakerInversionNotReadyError(reason)

        self.voice_asset_store.validate_owner_id(owner_id)
        voice_id = self.voice_asset_store.validate_name(voice_id)
        minimum = max(1, int(self.settings.speaker_inversion_min_samples))
        maximum = max(minimum, int(self.settings.speaker_inversion_max_samples))
        if len(samples) < minimum or len(samples) > maximum:
            raise ValueError(
                f"Provide between {minimum} and {maximum} training samples; got {len(samples)}."
            )
        max_file_bytes = max(1, int(self.settings.speaker_inversion_max_file_bytes))
        max_total_bytes = max(max_file_bytes, int(self.settings.speaker_inversion_max_total_bytes))
        total_bytes = 0
        validated: list[tuple[str, bytes, str, str]] = []
        for index, (filename, data, text, caption) in enumerate(samples):
            suffix = Path(filename).suffix.lower()
            if suffix not in VOICE_EXTENSIONS:
                allowed = ", ".join(sorted(VOICE_EXTENSIONS))
                raise ValueError(
                    f"Sample {index + 1} has unsupported extension {suffix!r}. Use: {allowed}."
                )
            if not data:
                raise ValueError(f"Sample {index + 1} is empty.")
            if len(data) > max_file_bytes:
                raise ValueError(
                    f"Sample {index + 1} exceeds the {max_file_bytes}-byte file limit."
                )
            clean_text = text.strip()
            clean_caption = caption.strip()
            if not clean_text or len(clean_text) > 4096:
                raise ValueError(f"Sample {index + 1} text must contain 1 to 4096 characters.")
            if len(clean_caption) > 1000:
                raise ValueError(f"Sample {index + 1} caption exceeds 1000 characters.")
            total_bytes += len(data)
            validated.append((suffix, data, clean_text, clean_caption))
        if total_bytes > max_total_bytes:
            raise ValueError(f"Training samples exceed the {max_total_bytes}-byte total limit.")

        try:
            self.workload_gate.reserve_training()
        except TrainingAlreadyReservedError as exc:
            raise SpeakerInversionBusyError(str(exc)) from exc

        job_id = f"spi_{uuid.uuid4().hex}"
        now = _utc_now()
        job = SpeakerInversionJob(
            id=job_id,
            voice_id=voice_id,
            status="queued",
            phase="waiting_for_inference",
            sample_count=len(validated),
            created_at=now,
            updated_at=now,
            progress_total=len(validated),
            message="Waiting for current speech generation to finish.",
            replace=bool(replace),
            owner_id=owner_id,
        )
        cancel_event = threading.Event()
        try:
            job_dir = self._job_dir(job_id)
            samples_dir = job_dir / "samples"
            samples_dir.mkdir(parents=True, exist_ok=False)
            sample_items = []
            for index, (suffix, data, text, caption) in enumerate(validated):
                path = samples_dir / f"sample_{index + 1:03d}{suffix}"
                path.write_bytes(data)
                sample_items.append(
                    {
                        "audio_path": str(path.resolve()),
                        "text": text,
                        "caption": caption,
                    }
                )
            (job_dir / "samples.json").write_text(
                json.dumps(
                    {"voice_id": voice_id, "samples": sample_items},
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            with self._lock:
                self._jobs[job_id] = job
                self._cancel_events[job_id] = cancel_event
                self._active_job_id = job_id
                self._write_state(job)
                if self._executor is None:
                    raise RuntimeError("Speaker Inversion executor is not running.")
                future = self._executor.submit(
                    self._run_job,
                    job_id,
                    training_root,
                    cancel_event,
                )
                self._futures[job_id] = future
        except Exception:
            with self._lock:
                self._active_job_id = None
            self.workload_gate.cancel_training_reservation()
            raise
        return job.api_dict()

    def get(self, job_id: str, owner_id: str) -> dict[str, Any]:
        self.startup()
        with self._lock:
            job = self._owned_job_locked(job_id, owner_id)
            return job.api_dict()

    def cancel(self, job_id: str, owner_id: str) -> dict[str, Any]:
        self.startup()
        with self._lock:
            job = self._owned_job_locked(job_id, owner_id)
            if job.status not in ACTIVE_STATUSES:
                return job.api_dict()
            job.status = "cancelling"
            job.phase = "cancelling"
            job.cancellation_requested = True
            job.message = "Stopping Speaker Inversion training."
            job.updated_at = _utc_now()
            self._write_state(job)
            cancel_event = self._cancel_events.get(job_id)
            process = self._processes.get(job_id)
            if cancel_event is not None:
                cancel_event.set()
        if process is not None:
            self._terminate_process(process)
        return self.get(job_id, owner_id)

    def result_path(self, job_id: str, owner_id: str) -> Path:
        self.startup()
        with self._lock:
            job = self._owned_job_locked(job_id, owner_id)
            if job.status != "completed" or job.result_filename is None:
                raise SpeakerInversionResultNotReadyError(
                    f"Speaker Inversion result is not ready; status={job.status}."
                )
            path = self._job_dir(job_id) / job.result_filename
        if not path.is_file():
            raise FileNotFoundError(f"Speaker Inversion result was not found: {path}")
        return path

    def save_result(
        self,
        job_id: str,
        owner_id: str,
        *,
        name: str | None = None,
    ) -> dict[str, Any]:
        result_path = self.result_path(job_id, owner_id)
        with self._lock:
            job = self._owned_job_locked(job_id, owner_id)
            asset_id = job.saved_asset_id
            asset_name = job.voice_id if name is None else name
        if asset_id is not None:
            try:
                return self.voice_asset_store.get(owner_id, asset_id).api_dict()
            except VoiceAssetNotFoundError:
                with self._lock:
                    job = self._owned_job_locked(job_id, owner_id)
                    job.saved_asset_id = None
                    self._write_state(job)

        asset = self.voice_asset_store.create_speaker_from_path(
            owner_id=owner_id,
            name=asset_name,
            source=result_path,
        )
        with self._lock:
            job = self._owned_job_locked(job_id, owner_id)
            job.saved_asset_id = asset.id
            job.updated_at = _utc_now()
            self._write_state(job)
        return asset.api_dict()

    def _run_job(
        self,
        job_id: str,
        training_root: Path,
        cancel_event: threading.Event,
    ) -> None:
        entered_training = False
        try:
            entered_training = self.workload_gate.enter_reserved_training(cancel_event)
            if not entered_training:
                raise _JobCancelledError()
            self._raise_if_cancelled(cancel_event)
            self._update(
                job_id,
                status="running",
                phase="preparing",
                progress_current=0,
                message="Resolving the base checkpoint.",
            )
            checkpoint_path = self.runtime_manager.resolve_checkpoint_path()
            self.runtime_manager.unload()
            self._raise_if_cancelled(cancel_event)

            job_dir = self._job_dir(job_id)
            manifest_path = job_dir / "manifest.jsonl"
            latent_dir = job_dir / "latents"
            prep_command = [
                sys.executable,
                "-m",
                "irodori_openai_tts.speaker_inversion_worker",
                "--samples-json",
                str(job_dir / "samples.json"),
                "--output-manifest",
                str(manifest_path),
                "--latent-dir",
                str(latent_dir),
                "--codec-repo",
                str(self.settings.codec_repo),
                "--device",
                str(self.settings.codec_device),
                "--precision",
                str(self.settings.codec_precision),
            ]
            self._run_process(job_id, prep_command, cancel_event, phase="preparing")
            self._raise_if_cancelled(cancel_event)

            max_steps = max(1, int(self.settings.speaker_inversion_max_steps))
            output_dir = job_dir / "output"
            device = str(self.settings.speaker_inversion_device).strip()
            if device.lower() in {"", "auto"}:
                device = default_runtime_device()
            precision = str(self.settings.speaker_inversion_precision).strip().lower()
            if device == "cpu":
                precision = "fp32"
            config_path = training_root / "configs" / "train_v4_small_speaker_inversion.yaml"
            train_command = [
                sys.executable,
                str(training_root / "train.py"),
                "--config",
                str(config_path),
                "--manifest",
                str(manifest_path),
                "--init-checkpoint",
                str(checkpoint_path),
                "--output-dir",
                str(output_dir),
                "--device",
                device,
                "--precision",
                precision,
                "--batch-size",
                str(max(1, int(self.settings.speaker_inversion_batch_size))),
                "--gradient-accumulation-steps",
                str(
                    max(
                        1,
                        int(self.settings.speaker_inversion_gradient_accumulation_steps),
                    )
                ),
                "--num-workers",
                str(max(0, int(self.settings.speaker_inversion_num_workers))),
                "--max-steps",
                str(max_steps),
                "--log-every",
                "1",
                "--save-every",
                str(min(250, max_steps)),
                "--checkpoint-best-n",
                "0",
                "--valid-ratio",
                "0",
                "--valid-every",
                "0",
                "--gradient-checkpointing",
                "--no-compile-model",
                "--no-progress",
                "--no-wandb",
            ]
            self._update(
                job_id,
                phase="training",
                progress_current=0,
                progress_total=max_steps,
                message="Speaker Inversion training started.",
            )
            self._run_process(job_id, train_command, cancel_event, phase="training")
            self._raise_if_cancelled(cancel_event)

            source = output_dir / f"checkpoint_final{SPEAKER_INVERSION_SUFFIX}"
            if not source.is_file():
                raise FileNotFoundError(f"Training did not create its final checkpoint: {source}")
            result_filename = f"result{SPEAKER_INVERSION_SUFFIX}"
            target = self._job_dir(job_id) / result_filename
            self._update(
                job_id,
                phase="finalizing",
                message="Preparing the private temporary result.",
            )
            temporary_target = target.with_suffix(target.suffix + f".{job_id}.tmp")
            shutil.copyfile(source, temporary_target)
            os.replace(temporary_target, target)
            self._update(
                job_id,
                status="completed",
                phase="completed",
                progress_current=max_steps,
                progress_total=max_steps,
                message=(
                    "Speaker Inversion completed. Download it or explicitly save it "
                    "to the owner's voice assets before it expires."
                ),
                result_filename=result_filename,
                error=None,
            )
        except _JobCancelledError:
            self._update(
                job_id,
                status="cancelled",
                phase="cancelled",
                message="Speaker Inversion was cancelled.",
                error=None,
            )
        except Exception as exc:
            logger.exception("Speaker Inversion job failed: %s", job_id)
            self._update(
                job_id,
                status="failed",
                phase="failed",
                message="Speaker Inversion failed.",
                error=str(exc)[:4000],
            )
        finally:
            try:
                if entered_training:
                    self.workload_gate.leave_training()
                else:
                    self.workload_gate.cancel_training_reservation()
            except RuntimeError:
                logger.exception("failed to release Speaker Inversion workload reservation")
            with self._lock:
                self._active_job_id = None
                self._processes.pop(job_id, None)
                self._cancel_events.pop(job_id, None)
                self._futures.pop(job_id, None)

    def _run_process(
        self,
        job_id: str,
        command: list[str],
        cancel_event: threading.Event,
        *,
        phase: str,
    ) -> None:
        environment = os.environ.copy()
        environment["PYTHONUNBUFFERED"] = "1"
        environment.setdefault("TOKENIZERS_PARALLELISM", "false")
        creationflags = 0
        if os.name == "nt":
            creationflags = int(getattr(subprocess, "CREATE_NO_WINDOW", 0))
        process = subprocess.Popen(
            command,
            cwd=str(self._job_dir(job_id)),
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creationflags,
        )
        with self._lock:
            self._processes[job_id] = process
        recent_lines: list[str] = []
        try:
            assert process.stdout is not None
            for raw_line in process.stdout:
                line = raw_line.strip()
                if not line:
                    continue
                recent_lines.append(line)
                recent_lines = recent_lines[-30:]
                logger.info("speaker job %s: %s", job_id, line)
                if line.startswith(EVENT_PREFIX):
                    try:
                        event = json.loads(line[len(EVENT_PREFIX) :])
                    except json.JSONDecodeError:
                        continue
                    self._update(
                        job_id,
                        phase=str(event.get("phase", phase)),
                        progress_current=int(event.get("current", 0)),
                        progress_total=int(event.get("total", 0)),
                        message=str(event.get("message", ""))[:500],
                    )
                elif phase == "training":
                    match = STEP_PATTERN.search(line)
                    if match is not None:
                        current = int(match.group(1))
                        with self._lock:
                            total = self._jobs[job_id].progress_total
                        self._update(
                            job_id,
                            progress_current=min(current, total),
                            message=line[:500],
                        )
                if cancel_event.is_set() and process.poll() is None:
                    self._terminate_process(process)
            return_code = process.wait()
        finally:
            with self._lock:
                self._processes.pop(job_id, None)
        if cancel_event.is_set():
            raise _JobCancelledError()
        if return_code != 0:
            details = "\n".join(recent_lines[-12:])
            raise RuntimeError(
                f"{phase.capitalize()} process exited with code {return_code}.\n{details}"
            )

    def _update(self, job_id: str, **changes: Any) -> None:
        with self._lock:
            job = self._jobs[job_id]
            for key, value in changes.items():
                setattr(job, key, value)
            job.updated_at = _utc_now()
            if job.status in TERMINAL_STATUSES and job.expires_at is None:
                job.expires_at = self._expiration_from(job.updated_at)
            self._write_state(job)

    def _write_state(self, job: SpeakerInversionJob) -> None:
        state_path = self._job_dir(job.id) / "state.json"
        state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = state_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(asdict(job), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary, state_path)

    def _resolve_training_root(self) -> tuple[Path | None, str | None]:
        explicit = self.settings.speaker_inversion_training_root
        if explicit is not None:
            path = explicit.expanduser().resolve()
            if self._valid_training_root(path):
                return path, None
            return None, f"IRODORI_SPEAKER_INVERSION_TRAINING_ROOT is invalid: {path}"

        candidates: list[Path] = []
        source_path = Path(__file__).resolve()
        candidates.extend(
            [
                Path.cwd() / "Irodori-TTS",
                source_path.parents[3] / "Irodori-TTS",
            ]
        )
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            uv_checkouts = Path(local_app_data) / "uv" / "cache" / "git-v0" / "checkouts"
            if uv_checkouts.is_dir():
                candidates.extend(path.parent for path in uv_checkouts.glob("*/*/train.py"))
        unix_uv_checkouts = Path.home() / ".cache" / "uv" / "git-v0" / "checkouts"
        if unix_uv_checkouts.is_dir():
            candidates.extend(path.parent for path in unix_uv_checkouts.glob("*/*/train.py"))
        valid = [path.resolve() for path in candidates if self._valid_training_root(path)]
        if valid:
            valid.sort(key=lambda path: (path / "train.py").stat().st_mtime, reverse=True)
            return valid[0], None
        return (
            None,
            "Irodori-TTS training sources were not found. Set "
            "IRODORI_SPEAKER_INVERSION_TRAINING_ROOT to an Irodori-TTS checkout.",
        )

    @staticmethod
    def _valid_training_root(path: Path) -> bool:
        return (path / "train.py").is_file() and (
            path / "configs" / "train_v4_small_speaker_inversion.yaml"
        ).is_file()

    @staticmethod
    def _terminate_process(process: subprocess.Popen[str]) -> None:
        if process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    @staticmethod
    def _raise_if_cancelled(cancel_event: threading.Event) -> None:
        if cancel_event.is_set():
            raise _JobCancelledError()

    def _owned_job_locked(self, job_id: str, owner_id: str) -> SpeakerInversionJob:
        self.voice_asset_store.validate_owner_id(owner_id)
        job = self._jobs.get(job_id)
        if job is None or job.owner_id != owner_id:
            raise SpeakerInversionNotFoundError(job_id)
        return job

    def _cleanup_loop(self) -> None:
        interval = max(
            1.0,
            float(self.settings.speaker_inversion_cleanup_interval_seconds),
        )
        while not self._cleanup_event.wait(interval):
            self._cleanup_expired_jobs()

    def _cleanup_expired_jobs(self) -> int:
        with self._lock:
            return self._cleanup_expired_jobs_locked()

    def _cleanup_expired_jobs_locked(self) -> int:
        now = datetime.now(timezone.utc)
        expired_ids = []
        for job_id, job in self._jobs.items():
            if job.status not in TERMINAL_STATUSES or job.expires_at is None:
                continue
            try:
                expires_at = datetime.fromisoformat(job.expires_at)
            except ValueError:
                expires_at = now
            if expires_at <= now:
                expired_ids.append(job_id)

        root = self._jobs_root()
        deleted = 0
        for job_id in expired_ids:
            if re.fullmatch(r"spi_[a-f0-9]{32}", job_id) is None:
                logger.error("refusing to delete invalid Speaker Inversion job ID: %r", job_id)
                continue
            job_dir = self._job_dir(job_id).resolve()
            if job_dir.parent != root:
                logger.error("refusing to delete Speaker Inversion path outside jobs root: %s", job_dir)
                continue
            if job_dir.exists():
                shutil.rmtree(job_dir)
            self._jobs.pop(job_id, None)
            deleted += 1
        return deleted

    def _expiration_from(self, timestamp: str) -> str:
        try:
            base = datetime.fromisoformat(timestamp)
        except ValueError:
            base = datetime.now(timezone.utc)
        ttl_hours = max(0.0, float(self.settings.speaker_inversion_result_ttl_hours))
        return (base + timedelta(hours=ttl_hours)).astimezone(timezone.utc).isoformat()

    def _jobs_root(self) -> Path:
        return self.settings.speaker_inversion_jobs_dir.expanduser().resolve()

    def _job_dir(self, job_id: str) -> Path:
        return self._jobs_root() / job_id


def _result_download_filename(voice_name: str) -> str:
    safe_name = "".join(
        "_" if char in '<>:"/\\|?*' or ord(char) < 32 else char for char in voice_name
    )
    safe_name = safe_name.strip(" .") or "voice"
    return f"{safe_name}{SPEAKER_INVERSION_SUFFIX}"
