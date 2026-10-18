"""60-minute duration, disk streaming, and original-frame preservation regression."""

import os

import pytest

from movie_worker import media


@pytest.mark.skipif(
    os.environ.get("MOVIE_LONG_TEST") != "1",
    reason="Set MOVIE_LONG_TEST=1 for the 60-minute media test",
)
def test_sixty_minute_export(tmp_path):
    source = tmp_path / "input.mp4"
    media.ffmpeg(
        [
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=160x90:r=1:d=3600",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=3600",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=48000:cl=mono",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            "-t",
            "3600",
            source,
        ]
    )
    info = media.inspect(source)
    assert info["duration"] == 3600
    media.extract(source, tmp_path / "game.wav", 1, info["origin"], 3600, lambda: None)
    media.extract(
        source,
        tmp_path / "commentary-source.wav",
        2,
        info["origin"],
        3600,
        lambda: None,
    )
    media.mix(
        dict(media=info, segments=[], game_gain=1, voice_gain=1), tmp_path, lambda: None
    )
    output = media.probe(tmp_path / "output.mp4")
    assert abs(float(output["format"]["duration"]) - 3600) <= 0.1
    assert (
        media.probe(source)["streams"][0]["nb_frames"]
        == output["streams"][0]["nb_frames"]
    )
