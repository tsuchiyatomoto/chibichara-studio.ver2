import numpy as np
import pytest
import soundfile as sf

from movie_worker import media


def test_audio_offset_is_relative_to_video(tmp_path):
    movie = tmp_path / "offset.mp4"
    media.ffmpeg(
        [
            "-f",
            "lavfi",
            "-i",
            "color=s=160x90:r=10:d=4",
            "-itsoffset",
            "0.75",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=3",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000:duration=4",
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
            "4",
            movie,
        ]
    )
    info = media.inspect(movie)
    media.extract(
        movie, tmp_path / "audio.wav", 1, info["origin"], info["duration"], lambda: None
    )
    data, sr = sf.read(tmp_path / "audio.wav", always_2d=True)
    assert np.max(np.abs(data[: int(0.65 * sr)])) < 0.001
    assert np.max(np.abs(data[int(0.85 * sr) : int(1.5 * sr)])) > 0.01
    assert len(data) == round(info["duration"] * sr)


def test_single_stereo_track_is_not_two_streams(tmp_path):
    movie = tmp_path / "stereo.mp4"
    media.ffmpeg(
        [
            "-f",
            "lavfi",
            "-i",
            "color=s=160x90:r=10:d=1",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=48000:cl=stereo",
            "-t",
            "1",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            movie,
        ]
    )
    with pytest.raises(ValueError, match="独立した2本"):
        media.inspect(movie)


def test_phase_cancelled_stereo_preserves_voice(tmp_path):
    wave = 0.05 * np.sin(2 * np.pi * 440 * np.arange(48000) / 48000)
    sf.write(tmp_path / "stereo.wav", np.column_stack([wave, -wave]), 48000)
    warning = media.mono(tmp_path / "stereo.wav", tmp_path / "mono.wav")
    data, _ = sf.read(tmp_path / "mono.wav")
    assert warning and np.max(np.abs(data)) > 0.04
