import sys
from types import ModuleType

import numpy as np
import pytest

from movie_worker import analysis


def speech(start, end):
    return {"start": round(start * 16000), "end": round(end * 16000)}


def test_brief_unexplained_gaps_do_not_become_vocalizations():
    groups = [dict(start=1, end=2, text="はい")]
    assert analysis.unexplained_speech(groups, [speech(.65, 2.4), speech(3, 3.49)]) == []
    assert len(analysis.unexplained_speech(groups, [speech(3, 3.5)])) == 1


def test_short_known_speech_and_vocalizations_are_preserved():
    assert analysis.short_unexplained(dict(start=0, end=.35, text=""))
    assert not analysis.short_unexplained(dict(start=0, end=.1, text="うん"))
    assert not analysis.short_unexplained(dict(start=0, end=.1, text="", vocalization="laugh"))


def test_alignment_window_recovers_tail_without_crossing_next_transcript():
    transcript = [
        {"start": 1.3, "end": 5.12, "text": "思います。"},
        {"start": 5.88, "end": 10.22, "text": "お願いします。"},
    ]
    windows = analysis.alignment_windows(
        transcript, [speech(2.908, 5.924), speech(9.5, 11.044)], 12.067
    )
    assert windows[0]["end"] == 5.88
    assert windows[1]["end"] == 11.044
    assert transcript[0]["end"] == 5.12
    assert transcript[1]["start"] == 5.88


@pytest.mark.parametrize(
    "events,duration,expected",
    [
        ([speech(1, 10)], 12, 3.0),  # Bounded even in continuous speech.
        ([speech(1, 4)], 2.4, 2.4),  # Never read beyond the recording.
        ([speech(0.5, 1.8), speech(2.2, 3)], 4, 2.0),  # Separate vocalization.
        ([speech(2, 3)], 4, 2.0),  # A later event starts at the boundary.
        ([], 4, 2.0),
    ],
)
def test_alignment_window_keeps_correction_local(events, duration, expected):
    windows = analysis.alignment_windows(
        [{"start": 0.5, "end": 2.0, "text": "はい。"}], events, duration
    )
    assert windows[0]["end"] == expected


def test_alignment_window_does_not_absorb_next_text_in_continuous_speech():
    windows = analysis.alignment_windows(
        [
            {"start": 0.5, "end": 2.0, "text": "はい。"},
            {"start": 2.0, "end": 3.0, "text": "次です。"},
        ],
        [speech(0.5, 3.5)],
        4,
    )
    assert windows[0]["end"] == 2.0


def test_genuine_unexplained_vocalizations_remain_reviewable():
    groups = [{"start": 1.2, "end": 2.0, "text": "はい。"}]
    extra = analysis.unexplained_speech(
        groups, [speech(0.5, 2.7), speech(3.2, 3.8)]
    )
    assert [(s["start"], s["end"]) for s in extra] == [
        (0.5, 1.2), (2.0, 2.7), (3.2, 3.8)
    ]
    assert all(s["text"] == "" and s["issue"] for s in extra)
    assert len(groups) == 1


def test_vad_tail_is_pending_until_audio_analysis_classifies_it():
    transcript = [{
        "start": 1.62,
        "end": 4.56,
        "text": "これから、ワールド・オブ・タンクスを始めたいと思います。",
    }]
    groups = transcript + analysis.unexplained_speech(
        transcript, [speech(1.916, 5.284)]
    )
    segments = analysis.initialize_segments(groups)
    tail = segments[1]
    assert (tail["start"], tail["end"]) == (4.56, 5.284)
    assert tail["analysis_issue"] == "pending_audio"
    assert tail["nonverbal"] is False
    assert "確認中" in tail["issue"]


def test_aligner_sees_syllable_tail_before_unknown_speech_is_created(monkeypatch):
    # ASR recognized the full sentence but ended its time range mid-syllable.
    # This aligner only succeeds if given audio through the actual word ending.
    module = ModuleType("whisperx.alignment")
    module.load_align_model = lambda **kwargs: (object(), {})

    def align(segments, *args, **kwargs):
        assert segments[0]["end"] == pytest.approx(2.8)
        return {"segments": [{"chars": [
            {"char": "思", "start": 1.0, "end": 1.4},
            {"char": "い", "start": 1.4, "end": 1.7},
            {"char": "ま", "start": 1.7, "end": 2.3},
            {"char": "す", "start": 2.3, "end": 2.7},
            {"char": "。"},
        ]}]}

    module.align = align
    monkeypatch.setitem(sys.modules, "whisperx.alignment", module)
    segments = analysis.align_transcript(
        [{"start": 1.0, "end": 2.0, "text": "思います。"}],
        np.zeros(3 * 16000, dtype=np.float32),
        [speech(0.9, 2.8)],
        lambda: None,
        lambda message: None,
    )
    assert len(segments) == 1
    assert segments[0]["text"] == "思います。"
    assert segments[0]["end"] == 2.7
    assert segments[0]["nonverbal"] is False
