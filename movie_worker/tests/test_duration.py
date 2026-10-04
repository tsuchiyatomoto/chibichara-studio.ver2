import pytest

from movie_worker import media


@pytest.mark.parametrize("duration_source", ["video", "container"])
@pytest.mark.parametrize(
    "duration,accepted",
    [
        (1800.001, True),
        (3600, True),
        (3600.001, False),
        (0, False),
        (float("nan"), False),
        (float("inf"), False),
    ],
)
def test_movie_duration_limit(monkeypatch, duration_source, duration, accepted):
    video = {"index": 0, "codec_type": "video", "codec_name": "h264"}
    container = {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": str(duration)}
    if duration_source == "video":
        video["duration"] = str(duration)
    info = {"format": container, "streams": [
        video,
        {"index": 1, "codec_type": "audio", "codec_name": "aac"},
        {"index": 2, "codec_type": "audio", "codec_name": "aac"},
    ]}
    monkeypatch.setattr(media, "probe", lambda *args: info)
    if accepted:
        assert media.inspect("movie.mp4")["duration"] == duration
    else:
        with pytest.raises(ValueError, match="動画は60分以内にしてください。"):
            media.inspect("movie.mp4")
