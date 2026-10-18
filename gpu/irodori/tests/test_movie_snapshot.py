import pytest

from irodori_openai_tts.config import Settings
from irodori_openai_tts.voice_assets import VoiceAssetStore, VoiceAssetNotFoundError
from test_voice_assets import speaker_file_bytes


def test_snapshot_survives_replacement_and_is_scoped(tmp_path):
    store = VoiceAssetStore(Settings(voice_assets_dir=tmp_path / "assets", _env_file=None))
    try:
        original = store.create_speaker(owner_id="owner", name="first", filename="first.speaker.safetensors", data=speaker_file_bytes())
        snapshot = store.snapshot_bytes("owner", original.id)
        with pytest.raises(VoiceAssetNotFoundError):
            store.snapshot_bytes("other", original.id)
        store.create_speaker(owner_id="owner", name="next", filename="next.speaker.safetensors", data=speaker_file_bytes())
        assert snapshot == speaker_file_bytes()
        assert not original.path.exists()
    finally:
        store.shutdown()
