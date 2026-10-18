import copy
import io
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from movie_worker import analysis, audio_events, media, speech_recovery as recovery


def expression(**changes):
    return analysis.Expression(**dict(dict(
        id="34", emotion="surprise", style="normal", strength=.8, pace="normal",
        suggested_text="マジか。", emphasis="", nonverbal=False,
        vocalization="none", uncertainty=""), **changes))


def segment(**changes):
    return dict(dict(id="34", start=174.82, end=175.812, text="マジか。", reading="マジか。",
                     aligned_start=175.103, aligned_end=175.812, alignment_warning=None,
                     issue=recovery.REVIEW_ISSUE, analysis_failed=True,
                     emotion="neutral", style="normal", strength=.5,
                     mode="tts", nonverbal=False, status="review", attempts=0, revision=0), **changes)


def review(**changes):
    return recovery.SpeechReview(**dict(dict(
        id="34", audio_understood=True, content="confirmed", expression_confident=True,
        emotion="surprise", style="normal", strength=.8, pace="normal",
        vocalization="none", reason="台詞を確認できました。"), **changes))


@pytest.fixture
def acoustic():
    audio = np.sin(np.arange(178 * 16000, dtype=np.float32) * .1) * .03
    vad = [dict(start=round(175.1 * 16000), end=round(175.812 * 16000)),
           dict(start=round(175.964 * 16000), end=round(176.836 * 16000))]
    return dict(audio=audio, vad=vad)


def recover(tmp_path, rows, acoustic, **kw):
    recovery.recover_segments(None, rows, tmp_path, lambda: None, lambda _: None, **acoustic, **kw)


def no_request(*args):
    pytest.fail("This case must not make an external request")


def test_real_38ms_gap_recovers_after_alignment_without_new_transcription(tmp_path, monkeypatch, acoustic):
    monkeypatch.setattr(recovery, "request_review", no_request)
    event = dict(start=175.358, end=175.812, text="うんちか", expression=expression())
    source = [dict(start=174.82, end=175.32, text="マジか。")]
    orphan = audio_events.canonicalize_transcript_events([event], source, 178)[0]
    assert orphan["analysis_failed"]
    current = segment()
    current.update(asr_source_index=0, analysis_issue=orphan["analysis_issue"])
    laugh = dict(id="35", start=175.964, end=176.836, text="", nonverbal=True, status="done")
    before = copy.deepcopy(laugh)
    recover(tmp_path, [current, laugh], acoustic, events=[event])
    assert current["issue"] is None and not current["analysis_failed"]
    assert current["text"] == current["reading"] == "マジか。"
    assert current["emotion"] == "surprise" and current["status"] == "pending"
    assert current["start"] == pytest.approx(175.1) and current["end"] == pytest.approx(175.812)
    assert current["analysis_resolution"]["method"] == "aligned_event"
    assert laugh == before and current["id"] == "34"


@pytest.mark.parametrize("events,neighbor", [
    ([dict(start=174, end=174.5, expression=expression())], None),
    ([dict(start=175.358, end=175.812, expression=expression(uncertainty="聞き取れない"))], None),
    ([dict(start=175.358, end=175.812, expression=expression(nonverbal=True, vocalization="laugh"))], None),
    ([dict(start=175.358, end=175.812, expression=expression(), analysis_failed=True)], None),
    ([dict(start=175.2, end=176.2, expression=expression())], dict(start=175.9, end=176.5)),
    ([dict(start=175.2, end=175.812, expression=expression()),
      dict(start=175.3, end=175.812, expression=expression())], None),
])
def test_rematching_rejects_ambiguous_failed_or_neighbor_events(events, neighbor):
    current = segment()
    rows = [current] + ([neighbor] if neighbor else [])
    bounds = dict(start=current["aligned_start"], end=current["aligned_end"])
    assert recovery.matched_expression(current, bounds, rows, events) is None


@pytest.mark.parametrize("confident,emotion,method,expected", [
    (True, "surprise", "isolated_review", "surprise"),
    (False, "unknown", "neutral_expression", "neutral"),
    (True, "unknown", "neutral_expression", "neutral"),
])
def test_isolated_review_uses_stable_id_and_only_defaults_uncertain_expression(
        tmp_path, monkeypatch, acoustic, confident, emotion, method, expected):
    calls = []
    def request(data, target, check, diagnostics=None):
        calls.append(target["id"])
        samples, rate = sf.read(io.BytesIO(data))
        assert rate == 16000 and len(samples) / rate == pytest.approx(.712)
        assert target["text"] == "マジか。"
        return review(expression_confident=confident, emotion=emotion)
    monkeypatch.setattr(recovery, "request_review", request)
    current = segment()
    recover(tmp_path, [current], acoustic)
    assert current["emotion"] == expected and current["issue"] is None
    assert current["analysis_resolution"]["method"] == method
    assert current["revision"] == 1 and calls == ["34"]
    # The cache is keyed by original audio, text and ID, not the old timestamps.
    another = segment()
    recover(tmp_path, [another], acoustic)
    assert another["issue"] is None and calls == ["34"]


@pytest.mark.parametrize("content", ["uncertain", "mismatch", "no_speech"])
def test_uncertain_content_never_becomes_neutral_speech(tmp_path, monkeypatch, acoustic, content):
    calls = []
    monkeypatch.setattr(recovery, "request_review", lambda *args: (
        calls.append(1) or review(content=content, expression_confident=False)))
    current = segment()
    recover(tmp_path, [current], acoustic)
    assert current["issue"] and current["analysis_failed"] and current["status"] == "review"
    assert current["analysis_issue"] == "content_uncertain" and len(calls) == 2
    assert current["revision"] == 0 and current["start"] == 174.82
    recover(tmp_path, [current], acoustic)
    assert len(calls) == 2  # Bounded cached attempts, even on repeated Continue.


def test_second_clip_with_context_can_recover_and_stays_inside_neighbors(tmp_path, monkeypatch, acoustic):
    lengths = []
    def request(data, target, check, diagnostics=None):
        samples, rate = sf.read(io.BytesIO(data))
        lengths.append(len(samples) / rate)
        return review(content="uncertain" if len(lengths) == 1 else "confirmed")
    monkeypatch.setattr(recovery, "request_review", request)
    current = segment()
    previous = dict(id="33", start=173, end=175.05, text="前", status="done")
    # The old conservative start overlaps the neighbor: do not silently edit it.
    current["start"] = 175.05
    following = dict(id="35", start=175.9, end=176.9, text="後", status="done")
    recover(tmp_path, [previous, current, following], acoustic)
    assert lengths == pytest.approx([.712, .85])
    assert current["issue"] is None
    assert previous["end"] <= current["start"] < current["end"] <= following["start"]


@pytest.mark.parametrize("answer", [review(id="wrong"), review(audio_understood=False),
                                    review(reason="I cannot directly process audio files.")])
def test_invalid_or_unavailable_answers_do_not_clear_issue(tmp_path, monkeypatch, acoustic, answer):
    monkeypatch.setattr(recovery, "request_review", lambda *args: answer)
    current = segment()
    recover(tmp_path, [current], acoustic)
    assert current["issue"] and current["analysis_failed"]
    assert not list(tmp_path.glob("speech-review-*.json"))


def test_service_failure_is_bounded_and_does_not_abort_other_rows(tmp_path, monkeypatch, acoustic):
    import httpx
    calls = []
    def request(*args):
        calls.append(1)
        raise httpx.ReadTimeout("timeout")
    monkeypatch.setattr(recovery, "request_review", request)
    current = segment()
    recover(tmp_path, [current], acoustic)
    assert current["issue"] and current["analysis_issue"] == "audio_unavailable"
    assert len(calls) == 2


def test_cancellation_propagates_without_partial_acceptance(tmp_path, monkeypatch, acoustic):
    def cancel(*args):
        raise media.Cancelled()
    monkeypatch.setattr(recovery, "request_review", cancel)
    current = segment()
    before = dict(current)
    with pytest.raises(media.Cancelled):
        recover(tmp_path, [current], acoustic)
    assert current == before


@pytest.mark.parametrize("changes", [dict(mode="mute"), dict(status="done"),
                                     dict(status="accepted"), dict(issue=None),
                                     dict(text="", nonverbal=True),
                                     dict(issue="生成音声が不正です。")])
def test_accepted_edits_nonverbal_and_synthesis_errors_are_untouched(tmp_path, monkeypatch, changes):
    monkeypatch.setattr(recovery, "request_review", no_request)
    current = segment(**changes)
    before = dict(current)
    recovery.recover_segments(None, [current], tmp_path, lambda: None, lambda _: None)
    assert current == before


def test_bad_alignment_or_no_vad_cannot_be_accepted(tmp_path, monkeypatch, acoustic):
    monkeypatch.setattr(recovery, "request_review", no_request)
    attempts = []
    def align(rows, *args):
        attempts.append(rows[0])
        rows[0]["alignment_warning"] = "文字の時刻が不確かです。"
    monkeypatch.setattr(audio_events, "align_speech", align)
    current = segment(alignment_warning="文字の時刻が不確かです。")
    recover(tmp_path, [current], acoustic)
    assert current["issue"] and len(attempts) == 1
    assert current["start"] == 174.82
    current = segment()
    recover(tmp_path, [current], dict(audio=acoustic["audio"], vad=[]))
    assert current["issue"] and current["analysis_issue"] == "timing"


def test_collapsed_duplicate_without_acoustic_support_is_silenced(
        tmp_path, monkeypatch, acoustic):
    monkeypatch.setattr(recovery, "request_review", no_request)
    monkeypatch.setattr(audio_events, "align_speech", lambda *args: None)
    previous = segment(id="33", start=173, end=174, issue=None,
                       analysis_failed=False, status="done",
                       text="同じ台詞です。", reading="同じ台詞です。",
                       aligned_start=173.1, aligned_end=173.8)
    current = segment(start=174.82, end=174.86, aligned_start=None, aligned_end=None,
                      text="同じ台詞です。", reading="同じ台詞です。",
                      alignment_warning="時刻が不確かです。", analysis_issue="timing")
    vad = [dict(start=round(173.1 * 16000), end=round(173.8 * 16000))]
    recover(tmp_path, [previous, current], dict(audio=acoustic["audio"], vad=vad))
    assert current["mode"] == "mute" and current["status"] == "accepted"
    assert current["issue"] is None and not current["analysis_failed"]
    assert current["analysis_resolution"] == {
        "method": "duplicate_asr_silence",
        "previous_issue": recovery.REVIEW_ISSUE,
        "duplicate_of": "33",
    }
    assert current["revision"] == 1 and "重複" in current["fallback_reason"]


@pytest.mark.parametrize("previous_text,previous_end", [
    ("別の台詞です。", 174),
    ("同じ台詞です。", 164),
])
def test_collapsed_row_is_not_silenced_without_a_nearby_matching_utterance(
        tmp_path, monkeypatch, acoustic, previous_text, previous_end):
    monkeypatch.setattr(recovery, "request_review", no_request)
    monkeypatch.setattr(audio_events, "align_speech", lambda *args: None)
    previous = segment(id="33", start=previous_end - 1, end=previous_end,
                       text=previous_text, reading=previous_text, issue=None,
                       analysis_failed=False, status="done",
                       aligned_start=previous_end - .9, aligned_end=previous_end - .2)
    current = segment(start=174.82, end=174.86, aligned_start=None, aligned_end=None,
                      text="同じ台詞です。", reading="同じ台詞です。",
                      alignment_warning="時刻が不確かです。", analysis_issue="timing")
    vad = [dict(start=round((previous_end - .9) * 16000),
                end=round((previous_end - .2) * 16000))]
    recover(tmp_path, [previous, current], dict(audio=acoustic["audio"], vad=vad))
    assert current["mode"] == "tts" and current["status"] == "review"
    assert current["issue"] == recovery.REVIEW_ISSUE


def test_local_alignment_retry_can_resolve_timing_before_review(tmp_path, monkeypatch, acoustic):
    def align(rows, *args):
        rows[0].update(aligned_start=175.103, aligned_end=175.812, alignment_warning=None)
    monkeypatch.setattr(audio_events, "align_speech", align)
    monkeypatch.setattr(recovery, "request_review", lambda *args: review())
    current = segment(end=175.32, alignment_warning="時刻が不確かです。")
    recover(tmp_path, [current], acoustic)
    assert current["issue"] is None and current["end"] == pytest.approx(175.812)


def test_request_schema_and_prompt_do_not_request_another_transcript(monkeypatch):
    from google import genai
    from google.genai import _transformers
    _transformers.t_schema(None, recovery.SpeechReview)
    calls, closed = [], []
    def generate(**kw):
        calls.append(kw)
        return SimpleNamespace(candidates=[SimpleNamespace(finish_reason="STOP")],
                               text=review().model_dump_json())
    monkeypatch.setattr(genai, "Client", lambda **kw: SimpleNamespace(
        models=SimpleNamespace(generate_content=generate), close=lambda: closed.append(True)))
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "test")
    response = recovery.request_review(b"audio", segment(), lambda: None)
    assert response.content == "confirmed" and closed == [True]
    parts = calls[0]["contents"][0].parts
    assert parts[0].inline_data.data == b"audio"
    assert '"id": "34"' in parts[1].text and '"text": "マジか。"' in parts[1].text


def test_analyze_events_runs_recovery_after_alignment_and_keeps_laughter(tmp_path, monkeypatch):
    import faster_whisper.vad
    from google import genai
    samples = np.sin(np.arange(3 * 16000, dtype=np.float32) * .1) * .03
    source = tmp_path / "audio.wav"
    sf.write(source, samples, 16000)
    vad = [dict(start=17600, end=28992), dict(start=31424, end=45376)]
    monkeypatch.setattr(faster_whisper.vad, "get_speech_timestamps", lambda *args: vad)
    monkeypatch.setattr(genai, "Client", lambda **kw: SimpleNamespace(close=lambda: None))
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "test")
    # Trimming the leading silence moves the clip origin to .95s. A noise
    # boundary prevents snapping Gemini's delayed start back to the VAD start.
    spoken = audio_events.Event(**expression().model_dump(), start=.408, end=.858)
    laugh = audio_events.Event(**expression(nonverbal=True, suggested_text="", vocalization="laugh").model_dump(),
                               start=1.014, end=1.886)
    monkeypatch.setattr(audio_events, "request_events", lambda *args: (
        audio_events.Events(audio_understood=True, reason="", events=[spoken, laugh],
                            noise=[audio_events.Noise(start=.248, end=.328)]), None))
    def align(rows, *args):
        for row in rows:
            if row["text"]:
                row.update(aligned_start=1.103, aligned_end=1.812, alignment_warning=None)
    monkeypatch.setattr(audio_events, "align_speech", align)
    monkeypatch.setattr(recovery, "request_review", no_request)
    rows = audio_events.analyze_events(source, [dict(start=.82, end=1.32, text="マジか。")],
                                      tmp_path, lambda: None, lambda _: None)
    assert [s["id"] for s in rows] == ["1", "2"]
    assert rows[0]["text"] == "マジか。" and rows[0]["issue"] is None
    assert rows[0]["analysis_resolution"]["method"] == "aligned_event"
    assert rows[1]["nonverbal"] and rows[1]["vocalization"] == "laugh"
