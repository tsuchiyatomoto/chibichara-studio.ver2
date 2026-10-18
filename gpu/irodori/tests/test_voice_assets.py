from __future__ import annotations

import pytest
import torch
from safetensors.torch import save

from irodori_openai_tts.config import Settings
from irodori_openai_tts.voice_assets import (
    REFERENCE_KIND,
    SPEAKER_KIND,
    VoiceAssetNotFoundError,
    VoiceAssetStore,
)


def speaker_file_bytes() -> bytes:
    return save({"speaker_embedding": torch.zeros(16, 768)})


def test_speaker_assets_are_owner_scoped_and_use_opaque_ids(tmp_path) -> None:
    settings = Settings(voice_assets_dir=tmp_path / "assets", _env_file=None)
    store = VoiceAssetStore(settings)

    asset = store.create_speaker(
        owner_id="owner-one",
        name="Alice",
        filename="alice.speaker.safetensors",
        data=speaker_file_bytes(),
    )

    assert asset.id.startswith("vasset_")
    assert asset.kind == SPEAKER_KIND
    assert asset.persistent is True
    assert [item.id for item in store.list("owner-one", kind=SPEAKER_KIND)] == [asset.id]
    assert store.resolve("owner-one", asset.id).ref_embed == str(asset.path)
    with pytest.raises(VoiceAssetNotFoundError):
        store.get("owner-two", asset.id)
    assert store.delete("owner-two", asset.id) is False
    assert store.get("owner-one", asset.id).id == asset.id
    store.shutdown()


def test_new_speaker_replaces_previous_speaker_but_keeps_temporary_reference(
    tmp_path,
) -> None:
    settings = Settings(voice_assets_dir=tmp_path / "assets", _env_file=None)
    store = VoiceAssetStore(settings)
    wav = b"RIFF" + (b"\x00" * 4) + b"WAVE" + b"data"

    first = store.create_speaker(
        owner_id="owner-one",
        name="First",
        filename="first.speaker.safetensors",
        data=speaker_file_bytes(),
    )
    reference = store.create_temporary_reference(
        owner_id="owner-one",
        filename="reference.wav",
        data=wav,
    )
    second = store.create_speaker(
        owner_id="owner-one",
        name="Second",
        filename="second.speaker.safetensors",
        data=speaker_file_bytes(),
    )

    assert [item.id for item in store.list("owner-one", kind=SPEAKER_KIND)] == [second.id]
    with pytest.raises(VoiceAssetNotFoundError):
        store.get("owner-one", first.id)
    assert store.get("owner-one", reference.id).id == reference.id
    store.shutdown()


def test_speaker_asset_upload_rejects_unsafe_or_invalid_files(tmp_path) -> None:
    settings = Settings(voice_assets_dir=tmp_path / "assets", _env_file=None)
    store = VoiceAssetStore(settings)

    with pytest.raises(ValueError, match="suffix"):
        store.create_speaker(
            owner_id="owner-one",
            name="Unsafe",
            filename="unsafe.pt",
            data=b"pickle",
        )
    with pytest.raises(ValueError, match="Invalid Speaker Inversion"):
        store.create_speaker(
            owner_id="owner-one",
            name="Broken",
            filename="broken.speaker.safetensors",
            data=b"not-safetensors",
        )
    store.shutdown()


def test_temporary_reference_expires_and_is_deleted(tmp_path) -> None:
    settings = Settings(
        voice_assets_dir=tmp_path / "assets",
        voice_asset_temporary_ttl_hours=0,
        _env_file=None,
    )
    store = VoiceAssetStore(settings)
    wav = b"RIFF" + (b"\x00" * 4) + b"WAVE" + b"data"

    asset = store.create_temporary_reference(
        owner_id="owner-one",
        filename="reference.wav",
        data=wav,
    )

    assert asset.kind == REFERENCE_KIND
    assert asset.persistent is False
    with pytest.raises(VoiceAssetNotFoundError):
        store.get("owner-one", asset.id)
    assert not asset.path.exists()
    store.shutdown()
