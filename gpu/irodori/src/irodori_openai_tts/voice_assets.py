from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

import torch

from irodori_tts.speaker_inversion import load_speaker_inversion_payload

from .config import Settings
from .voices import SPEAKER_INVERSION_SUFFIX, VoiceSpec

ASSET_ID_PREFIX = "vasset_"
ASSET_ID_LENGTH = len(ASSET_ID_PREFIX) + 32
SPEAKER_KIND = "speaker_embedding"
REFERENCE_KIND = "reference_audio"
VoiceAssetKind = Literal["speaker_embedding", "reference_audio"]


class VoiceAssetNotFoundError(KeyError):
    pass


class VoiceAssetQuotaError(RuntimeError):
    pass


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


@dataclass(frozen=True)
class VoiceAsset:
    id: str
    name: str
    kind: VoiceAssetKind
    bytes: int
    created_at: str
    expires_at: str | None
    path: Path

    @property
    def persistent(self) -> bool:
        return self.expires_at is None

    def api_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "object": "voice_asset",
            "name": self.name,
            "kind": self.kind,
            "filename": _download_filename(self.name, self.kind),
            "bytes": self.bytes,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "persistent": self.persistent,
        }


class VoiceAssetStore:
    """Owner-scoped voice assets for untrusted application users.

    The owner identifier is never used as a path and is not persisted verbatim. The
    BFF supplies it from an authenticated account or an opaque browser session.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._lock = threading.RLock()
        self._cleanup_event = threading.Event()
        self._cleanup_thread: threading.Thread | None = None

    def startup(self) -> None:
        self.ensure_dir()
        with self._lock:
            if self._cleanup_thread is not None and self._cleanup_thread.is_alive():
                return
            self.cleanup_expired()
            self._cleanup_event = threading.Event()
            self._cleanup_thread = threading.Thread(
                target=self._cleanup_loop,
                name="voice-asset-cleanup",
                daemon=True,
            )
            self._cleanup_thread.start()

    def shutdown(self) -> None:
        with self._lock:
            thread = self._cleanup_thread
            self._cleanup_thread = None
            self._cleanup_event.set()
        if thread is not None:
            thread.join(timeout=2)

    def ensure_dir(self) -> Path:
        root = self.settings.voice_assets_dir.expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        return root

    def list(
        self,
        owner_id: str,
        *,
        kind: VoiceAssetKind | None = None,
        persistent_only: bool = False,
    ) -> list[VoiceAsset]:
        self.startup()
        self.validate_owner_id(owner_id)
        with self._lock:
            self._cleanup_expired_owner(owner_id)
            assets = self._list_owner_assets(owner_id)
        if kind is not None:
            assets = [asset for asset in assets if asset.kind == kind]
        if persistent_only:
            assets = [asset for asset in assets if asset.persistent]
        return sorted(assets, key=lambda asset: (asset.created_at, asset.id), reverse=True)

    def get(self, owner_id: str, asset_id: str) -> VoiceAsset:
        self.startup()
        self.validate_owner_id(owner_id)
        self.validate_asset_id(asset_id)
        with self._lock:
            self._cleanup_expired_owner(owner_id)
            asset = self._read_asset(self._owner_dir(owner_id) / asset_id)
        if asset is None:
            raise VoiceAssetNotFoundError(asset_id)
        return asset

    def snapshot_bytes(self, owner_id: str, asset_id: str) -> bytes:
        """Read immutable bytes while excluding replacement and expiry cleanup."""
        with self._lock:
            asset = self.get(owner_id, asset_id)
            if asset.kind != SPEAKER_KIND:
                raise ValueError("Only speaker embeddings can be snapshotted.")
            return asset.path.read_bytes()

    def snapshot_reference(self, owner_id: str, asset_id: str) -> tuple[VoiceSpec, bytes]:
        """Keep queued synthesis independent of replacement and temporary-asset expiry."""
        with self._lock:
            spec = self.resolve(owner_id, asset_id)
            asset = self.get(owner_id, asset_id)
            return spec, asset.path.read_bytes()

    def resolve(self, owner_id: str, asset_id: str) -> VoiceSpec:
        asset = self.get(owner_id, asset_id)
        if asset.kind == SPEAKER_KIND:
            return VoiceSpec(voice_id=asset.id, ref_embed=str(asset.path))
        if asset.kind == REFERENCE_KIND:
            return VoiceSpec(voice_id=asset.id, ref_wav=str(asset.path))
        raise VoiceAssetNotFoundError(asset_id)

    def create_speaker(
        self,
        *,
        owner_id: str,
        name: str,
        filename: str,
        data: bytes,
    ) -> VoiceAsset:
        if not Path(filename).name.lower().endswith(SPEAKER_INVERSION_SUFFIX):
            raise ValueError(f"Speaker assets must use the {SPEAKER_INVERSION_SUFFIX} suffix.")
        return self._create(
            owner_id=owner_id,
            name=name,
            kind=SPEAKER_KIND,
            suffix=SPEAKER_INVERSION_SUFFIX,
            data=data,
            expires_at=None,
            replace_existing_kind=SPEAKER_KIND,
        )

    def create_speaker_from_path(
        self,
        *,
        owner_id: str,
        name: str,
        source: Path,
    ) -> VoiceAsset:
        max_bytes = max(1, int(self.settings.voice_asset_max_file_bytes))
        if not source.is_file():
            raise FileNotFoundError(source)
        if source.stat().st_size > max_bytes:
            raise ValueError(f"Speaker asset exceeds the {max_bytes}-byte file limit.")
        return self.create_speaker(
            owner_id=owner_id,
            name=name,
            filename=source.name,
            data=source.read_bytes(),
        )

    def create_temporary_reference(
        self,
        *,
        owner_id: str,
        filename: str,
        data: bytes,
    ) -> VoiceAsset:
        suffix = Path(filename).suffix.lower()
        if suffix != ".wav":
            raise ValueError("Temporary voice references must be WAV files.")
        if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
            raise ValueError("Temporary voice reference is not a valid WAV container.")
        ttl_hours = max(0.0, float(self.settings.voice_asset_temporary_ttl_hours))
        expires_at = _utc_now() + timedelta(hours=ttl_hours)
        return self._create(
            owner_id=owner_id,
            name="Temporary voice reference",
            kind=REFERENCE_KIND,
            suffix=".wav",
            data=data,
            expires_at=expires_at,
        )

    def delete(self, owner_id: str, asset_id: str) -> bool:
        self.startup()
        self.validate_owner_id(owner_id)
        self.validate_asset_id(asset_id)
        with self._lock:
            asset_dir = self._owner_dir(owner_id) / asset_id
            if self._read_asset(asset_dir) is None:
                return False
            self._delete_asset_dir(asset_dir)
            return True

    def cleanup_expired(self) -> int:
        root = self.ensure_dir()
        deleted = 0
        with self._lock:
            for owner_dir in list(root.iterdir()):
                if not owner_dir.is_dir() or owner_dir.is_symlink():
                    continue
                for asset_dir in list(owner_dir.iterdir()):
                    asset = self._read_asset(asset_dir)
                    if asset is not None and self._is_expired(asset):
                        self._delete_asset_dir(asset_dir)
                        deleted += 1
                try:
                    owner_dir.rmdir()
                except OSError:
                    pass
        return deleted

    @staticmethod
    def validate_owner_id(owner_id: str) -> None:
        if not owner_id or len(owner_id) > 256 or any(ord(char) < 32 for char in owner_id):
            raise ValueError("A valid owner ID is required.")

    @staticmethod
    def validate_asset_id(asset_id: str) -> None:
        if (
            len(asset_id) != ASSET_ID_LENGTH
            or not asset_id.startswith(ASSET_ID_PREFIX)
            or any(char not in "0123456789abcdef" for char in asset_id[len(ASSET_ID_PREFIX) :])
        ):
            raise ValueError("Invalid voice asset ID.")

    @staticmethod
    def validate_name(name: str) -> str:
        clean = name.strip()
        if not clean or len(clean) > 80 or any(ord(char) < 32 for char in clean):
            raise ValueError("Voice name must contain 1 to 80 printable characters.")
        return clean

    def _create(
        self,
        *,
        owner_id: str,
        name: str,
        kind: VoiceAssetKind,
        suffix: str,
        data: bytes,
        expires_at: datetime | None,
        replace_existing_kind: VoiceAssetKind | None = None,
    ) -> VoiceAsset:
        self.startup()
        self.validate_owner_id(owner_id)
        clean_name = self.validate_name(name)
        max_bytes = max(1, int(self.settings.voice_asset_max_file_bytes))
        if not data:
            raise ValueError("Voice asset must not be empty.")
        if len(data) > max_bytes:
            raise ValueError(f"Voice asset exceeds the {max_bytes}-byte file limit.")

        with self._lock:
            self._cleanup_expired_owner(owner_id)
            existing = self._list_owner_assets(owner_id)
            replaced_assets = (
                [asset for asset in existing if asset.kind == replace_existing_kind]
                if replace_existing_kind is not None
                else []
            )
            retained_assets = [asset for asset in existing if asset not in replaced_assets]
            max_assets = max(1, int(self.settings.voice_asset_max_assets_per_owner))
            if len(retained_assets) >= max_assets:
                raise VoiceAssetQuotaError(f"Voice asset quota exceeded ({max_assets} files).")
            total_limit = max(max_bytes, int(self.settings.voice_asset_max_total_bytes_per_owner))
            if sum(asset.bytes for asset in retained_assets) + len(data) > total_limit:
                raise VoiceAssetQuotaError(
                    f"Voice asset storage quota exceeded ({total_limit} bytes)."
                )

            asset_id = f"{ASSET_ID_PREFIX}{uuid.uuid4().hex}"
            asset_dir = self._owner_dir(owner_id) / asset_id
            asset_dir.mkdir(parents=True, exist_ok=False)
            target = asset_dir / f"voice{suffix}"
            temporary = asset_dir / f"voice{suffix}.upload"
            try:
                temporary.write_bytes(data)
                if kind == SPEAKER_KIND:
                    self._validate_speaker_file(temporary, final_suffix=suffix)
                os.replace(temporary, target)
                now = _utc_now()
                metadata = {
                    "version": 1,
                    "id": asset_id,
                    "name": clean_name,
                    "kind": kind,
                    "bytes": len(data),
                    "created_at": _isoformat(now),
                    "expires_at": None if expires_at is None else _isoformat(expires_at),
                    "content_filename": target.name,
                }
                self._write_metadata(asset_dir, metadata)
            except Exception:
                self._delete_asset_dir(asset_dir)
                raise
            asset = self._read_asset(asset_dir)
            if asset is None:
                raise RuntimeError("Voice asset metadata could not be read after creation.")
            for replaced_asset in replaced_assets:
                self._delete_asset_dir(replaced_asset.path.parent)
            return asset

    def _validate_speaker_file(self, temporary: Path, *, final_suffix: str) -> None:
        validation_path = temporary.with_name(f"validation{final_suffix}")
        os.replace(temporary, validation_path)
        try:
            payload = load_speaker_inversion_payload(validation_path)
            embedding = payload["speaker_embedding"]
            if embedding.ndim != 2:
                raise ValueError(
                    "speaker_embedding must have shape (tokens, dim); "
                    f"got {tuple(embedding.shape)}."
                )
            tokens, dimension = (int(value) for value in embedding.shape)
            if not 1 <= tokens <= 256 or not 1 <= dimension <= 4096:
                raise ValueError(
                    f"speaker_embedding shape is outside safe limits: {(tokens, dimension)}."
                )
            if not embedding.is_floating_point() or not bool(torch.isfinite(embedding).all()):
                raise ValueError("speaker_embedding must contain finite floating-point values.")
        except Exception as exc:
            if isinstance(exc, ValueError):
                raise
            raise ValueError(f"Invalid Speaker Inversion safetensors file: {exc}") from exc
        finally:
            if validation_path.exists():
                os.replace(validation_path, temporary)

    def _cleanup_loop(self) -> None:
        interval = max(1.0, float(self.settings.voice_asset_cleanup_interval_seconds))
        while not self._cleanup_event.wait(interval):
            self.cleanup_expired()

    def _cleanup_expired_owner(self, owner_id: str) -> None:
        owner_dir = self._owner_dir(owner_id)
        if not owner_dir.is_dir():
            return
        for asset_dir in list(owner_dir.iterdir()):
            asset = self._read_asset(asset_dir)
            if asset is not None and self._is_expired(asset):
                self._delete_asset_dir(asset_dir)

    def _list_owner_assets(self, owner_id: str) -> list[VoiceAsset]:
        owner_dir = self._owner_dir(owner_id)
        if not owner_dir.is_dir():
            return []
        return [
            asset
            for asset_dir in owner_dir.iterdir()
            if (asset := self._read_asset(asset_dir)) is not None
        ]

    def _read_asset(self, asset_dir: Path) -> VoiceAsset | None:
        if not asset_dir.is_dir() or asset_dir.is_symlink():
            return None
        metadata_path = asset_dir / "metadata.json"
        if not metadata_path.is_file():
            return None
        try:
            raw = json.loads(metadata_path.read_text(encoding="utf-8"))
            asset_id = str(raw["id"])
            self.validate_asset_id(asset_id)
            if asset_id != asset_dir.name:
                return None
            kind = str(raw["kind"])
            if kind not in {SPEAKER_KIND, REFERENCE_KIND}:
                return None
            content_path = asset_dir / Path(str(raw["content_filename"])).name
            if not content_path.is_file():
                return None
            return VoiceAsset(
                id=asset_id,
                name=str(raw["name"]),
                kind=kind,  # type: ignore[arg-type]
                bytes=int(raw["bytes"]),
                created_at=str(raw["created_at"]),
                expires_at=None
                if raw.get("expires_at") is None
                else str(raw["expires_at"]),
                path=content_path,
            )
        except (KeyError, TypeError, ValueError, json.JSONDecodeError, OSError):
            return None

    @staticmethod
    def _is_expired(asset: VoiceAsset) -> bool:
        if asset.expires_at is None:
            return False
        try:
            expires_at = datetime.fromisoformat(asset.expires_at)
        except ValueError:
            return True
        return expires_at <= _utc_now()

    def _owner_dir(self, owner_id: str) -> Path:
        owner_key = hashlib.sha256(owner_id.encode("utf-8")).hexdigest()
        return self.ensure_dir() / owner_key

    @staticmethod
    def _write_metadata(asset_dir: Path, metadata: dict[str, Any]) -> None:
        target = asset_dir / "metadata.json"
        temporary = asset_dir / "metadata.json.tmp"
        temporary.write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary, target)

    @staticmethod
    def _delete_asset_dir(asset_dir: Path) -> None:
        if asset_dir.is_symlink():
            asset_dir.unlink(missing_ok=True)
        elif asset_dir.exists():
            shutil.rmtree(asset_dir)


def _download_filename(name: str, kind: VoiceAssetKind) -> str:
    safe_name = "".join("_" if char in '<>:"/\\|?*' or ord(char) < 32 else char for char in name)
    safe_name = safe_name.strip(" .") or "voice"
    suffix = SPEAKER_INVERSION_SUFFIX if kind == SPEAKER_KIND else ".wav"
    return f"{safe_name}{suffix}"
