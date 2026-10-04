import sys
from types import ModuleType, SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from movie_worker import analysis, audio_events, media


def event(start=0.2, end=1.2, text="こんにちはー", **kw):
    return audio_events.Event(
        start=start, end=end, suggested_text=text, emotion="neutral", style="normal",
        strength=0.5, emphasis="", pace="normal", nonverbal=not bool(text),
        vocalization="none" if text else "laugh", uncertainty="", **kw,
    )


def result(*events):
    return audio_events.Events(audio_understood=True, reason="", events=list(events))


def test_noise_explains_vad_without_creating_a_vocalization(audio_system, monkeypatch):
    path, raw, directory, _ = audio_system
    response = result(event(text=raw[0]["text"]))
    response.noise = [audio_events.Noise(start=1.8, end=2.8)]
    monkeypatch.setattr(audio_events, "request_events", lambda *args: (response, None))
    segments = audio_events.analyze_events(path, raw, directory, lambda: None, lambda _: None)
    assert len(segments) == 1
    assert segments[0]["issue"] is None


def test_gemini_fragments_are_rejoined_to_one_whisper_utterance():
    source = [dict(start=1, end=4, text="これから実況を始めます")]
    first = event(start=1, end=2, text="これから")
    second = event(start=2.1, end=3.9, text="実況を始めます")
    groups = audio_events.canonicalize_transcript_events([
        dict(start=1, end=2, text=first.suggested_text, expression=first),
        dict(start=2.1, end=3.9, text=second.suggested_text, expression=second),
    ], source, 5)
    assert len(groups) == 1
    assert groups[0]["text"] == source[0]["text"]
    assert groups[0]["start"] == 1 and groups[0]["end"] == 4
    assert groups[0]["expression"].suggested_text == source[0]["text"]


def test_unmatched_gemini_lexical_noise_is_dropped():
    source = [dict(start=1, end=2, text="こんにちは")]
    speech = event(start=1, end=2, text="こんにちは")
    hallucination = event(start=3, end=3.3, text="強い")
    groups = audio_events.canonicalize_transcript_events([
        dict(start=1, end=2, text=speech.suggested_text, expression=speech),
        dict(start=3, end=3.3, text=hallucination.suggested_text, expression=hallucination),
    ], source, 4)
    assert [g["text"] for g in groups] == ["こんにちは"]


@pytest.mark.parametrize("trailing", [False, True])
def test_shared_event_keeps_short_utterance_at_timing_threshold(trailing):
    # The real 116.86--117.46 utterance overlaps the combined event by .28s,
    # only .02s below half its duration. Small timestamp drift must not orphan it.
    source = [dict(start=116.86, end=117.46, text="というか"),
              dict(start=117.9, end=120.1, text="味方の配置がすげえな")]
    start, end = 117.18, 119.32
    if trailing:
        source = [dict(start=240 - s["end"], end=240 - s["start"], text=s["text"])
                  for s in reversed(source)]
        start, end = 240 - end, 240 - start
    shared = event(start=start, end=end, text="ていうか味方の配置がすげえな")
    groups = audio_events.canonicalize_transcript_events([
        dict(start=start, end=end, text=shared.suggested_text, expression=shared),
    ], source, 125)
    assert [g["text"] for g in groups] == [s["text"] for s in source]
    assert all(not g.get("analysis_failed") and not g.get("issue") for g in groups)
    assert all(g["expression"].suggested_text == g["text"] for g in groups)
    assert groups[0]["end"] <= groups[1]["start"]


@pytest.mark.parametrize("overlap", [0, .01, .2, .24])
def test_shared_event_does_not_claim_insufficiently_overlapping_neighbor(overlap):
    source = [dict(start=1, end=1.6, text="別の発言"),
              dict(start=2, end=4, text="次の発言です")]
    shared = event(start=1.6 - overlap, end=4, text="次の発言です")
    groups = audio_events.canonicalize_transcript_events([
        dict(start=shared.start, end=shared.end, text=shared.suggested_text,
             expression=shared),
    ], source, 5)
    assert groups[0]["analysis_failed"] and groups[0]["issue"]
    assert not groups[1].get("analysis_failed")


def test_shared_failed_event_does_not_clear_short_utterance_warning():
    source = [dict(start=116.86, end=117.46, text="というか"),
              dict(start=117.9, end=120.1, text="味方の配置がすげえな")]
    shared = event(start=117.18, end=119.32, text="ていうか味方の配置がすげえな")
    groups = audio_events.canonicalize_transcript_events([
        dict(start=shared.start, end=shared.end, text=shared.suggested_text,
             expression=shared, analysis_failed=True, issue="音声の位置が不確かです"),
    ], source, 125)
    assert all(g["analysis_failed"] and g["issue"] for g in groups)


def test_independent_laughter_survives_canonicalization():
    source = [dict(start=1, end=2, text="こんにちは")]
    speech = event(start=1, end=2, text="こんにちは")
    laugh = event(start=3, end=3.8, text="")
    groups = audio_events.canonicalize_transcript_events([
        dict(start=1, end=2, text=speech.suggested_text, expression=speech),
        dict(start=3, end=3.8, text="", expression=laugh),
    ], source, 4)
    assert len(groups) == 2
    assert groups[1]["expression"].nonverbal


def test_laughter_after_a_sentence_is_trimmed_and_preserved():
    source = [dict(start=1, end=2, text="こんにちは")]
    speech = event(start=1, end=2, text="こんにちは")
    laugh = event(start=1.8, end=2.8, text="")
    groups = audio_events.canonicalize_transcript_events([
        dict(start=1, end=2, text=speech.suggested_text, expression=speech),
        dict(start=1.8, end=2.8, text="", expression=laugh),
    ], source, 4)
    assert len(groups) == 2
    assert groups[1]["start"] == 2 and groups[1]["end"] == 2.8


def test_unexplained_gap_inside_whisper_speech_is_not_an_extra_row():
    source = [dict(start=1, end=4, text="こんにちは")]
    groups = audio_events.canonicalize_transcript_events([
        dict(start=1, end=2, text="こんにちは", expression=event(start=1, end=2)),
        dict(start=2, end=2.8, text="", coverage_gap=True, analysis_failed=True,
             issue="未判定"),
    ], source, 5)
    assert len(groups) == 1
    assert groups[0]["text"] == "こんにちは"


def test_noise_cannot_hide_overlapping_speech_or_invalid_timestamps():
    for start, end in [(1, 1.5), (2, 4), (2, 2), (float("nan"), 2)]:
        response = result(event())
        with pytest.raises(ValueError):
            response.noise = [audio_events.Noise(start=start, end=end)]
            audio_events.validate_events(response, 3)


def test_speech_snapping_does_not_absorb_lip_noise():
    groups = audio_events.snap_events(
        [event(start=.4, end=1.2)], [dict(start=1600, end=19200)], 2,
        [audio_events.Noise(start=.1, end=.3)])
    assert groups[0]["start"] == .4


def test_short_unexplained_sound_does_not_force_retry(audio_system, monkeypatch):
    import faster_whisper.vad
    path, raw, directory, _ = audio_system
    monkeypatch.setattr(faster_whisper.vad, "get_speech_timestamps", lambda *args: [
        dict(start=3200, end=19200), dict(start=28800, end=34400)])
    calls = []
    def request(*args):
        calls.append(1)
        unknown = event(start=1.8, end=2.15, text="")
        unknown.vocalization = "other"
        return result(event(), unknown), None
    monkeypatch.setattr(audio_events, "request_events", request)
    segments = audio_events.analyze_events(path, raw, directory, lambda: None, lambda _: None)
    assert len(segments) == 1 and len(calls) == 1
    assert not segments[0].get("analysis_failed")


def test_failed_analysis_does_not_restore_old_short_placeholders(audio_system, monkeypatch):
    path, raw, directory, _ = audio_system
    raw.append(dict(start=2.85, end=2.99, text=""))
    def request(*args):
        raise audio_events.AudioUnavailable("without audio")
    monkeypatch.setattr(audio_events, "request_events", request)
    segments = audio_events.analyze_events(path, raw, directory, lambda: None, lambda _: None)
    assert all(s["text"] for s in segments)


def test_zero_confidence_alignment_keeps_original_intervals(monkeypatch):
    module = ModuleType("whisperx.alignment")
    module.load_align_model = lambda **kw: (object(), {})
    module.align = lambda segments, *args, **kw: {"segments": [{"chars": [
        dict(char=c, start=segments[0]["start"] + i * .02,
             end=segments[0]["start"] + (i + 1) * .02, score=0)
        for i, c in enumerate(segments[0]["text"])
    ]}]}
    monkeypatch.setitem(sys.modules, "whisperx.alignment", module)
    raw = [dict(start=1.62, end=2.28, text="こんにちは"),
           dict(start=2.28, end=4.23, text="あはははは")]
    segments = analysis.align_transcript(raw, np.zeros(80000), [], lambda: None, lambda _: None)
    assert [(s["start"], s["end"], s["text"]) for s in segments] == [
        (1.62, 2.28, "こんにちは"), (2.28, 4.23, "あはははは")]
    assert all(s["issue"] for s in segments)


@pytest.mark.parametrize("text", [
    "Without audio, it's impossible to determine the sound.",
    "I am an AI and cannot process audio input to detect laughter.",
    "I cannot directly listen to or process audio files.",
    "音声が添付されていないため判断できません。",
])
def test_refusal_is_not_a_negative_audio_result(text):
    with pytest.raises(audio_events.AudioUnavailable):
        audio_events.require_audio_understanding(text)


def test_invalid_timestamps_and_lexical_laughter_are_rejected():
    with pytest.raises(ValueError):
        audio_events.validate_events(result(event(), event(start=1, end=2)), 3)
    with pytest.raises(ValueError):
        audio_events.validate_events(result(event(end=4)), 3)
    laugh = event(text="")
    laugh.suggested_text = "あはは"
    with pytest.raises(ValueError):
        audio_events.validate_events(result(laugh), 3)


def test_silent_timestamp_is_flagged_without_rejecting_supported_event():
    reviewed = audio_events.review_acoustic_coverage([
        dict(start=.5, end=.95), dict(start=1.9, end=4.6),
    ], [dict(start=30400, end=46400), dict(start=57600, end=73600)])
    assert reviewed[0]["analysis_failed"]
    assert "一致" in reviewed[0]["acoustic_warning"]
    assert not reviewed[1].get("analysis_failed")


@pytest.fixture
def audio_system(tmp_path, monkeypatch):
    import faster_whisper.vad
    from google import genai
    vad = [dict(start=3200, end=19200), dict(start=28800, end=44800)]
    monkeypatch.setattr(faster_whisper.vad, "get_speech_timestamps", lambda *args: vad)
    monkeypatch.setattr(genai, "Client", lambda **kw: SimpleNamespace(close=lambda: None))
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "test")
    path = tmp_path / "audio.wav"
    sf.write(path, np.linspace(0, .01, 48000), 16000)
    raw = [dict(start=.2, end=2.8, text="こんにちはあはははは")]
    aligned = []
    monkeypatch.setattr(audio_events, "align_speech", lambda ss, *args: aligned.extend(ss))
    return path, raw, tmp_path, aligned


def test_audio_events_replace_asr_merge_and_skip_old_cache(audio_system, monkeypatch):
    path, raw, directory, aligned = audio_system
    (directory / "analysis-0.json").write_text('{"old":true}')
    calls = []
    def request(*args):
        calls.append(1)
        return result(event(), event(start=1.8, end=2.8, text="")), None
    monkeypatch.setattr(audio_events, "request_events", request)
    segments = audio_events.analyze_events(path, raw, directory, lambda: None, lambda _: None)
    assert [s["text"] for s in segments] == [raw[0]["text"]]
    assert segments[0]["reading"] == raw[0]["text"]
    assert [s["id"] for s in segments] == ["1"]
    audio_events.analyze_events(path, raw, directory, lambda: None, lambda _: None)
    assert len(calls) == 1  # Content-addressed, validated cache.
    sf.write(path, np.ones(48000) * .01, 16000)
    audio_events.analyze_events(path, raw, directory, lambda: None, lambda _: None)
    assert len(calls) == 2


def test_retry_on_shorter_audio_recovers_separate_events(audio_system, monkeypatch):
    path, raw, directory, _ = audio_system
    lengths = []
    def request(client, data, duration, check):
        lengths.append(duration)
        if len(lengths) == 1:
            raise audio_events.AudioUnavailable("without audio")
        if len(lengths) == 2:
            return result(event()), None
        return result(event(start=.3, end=1.3, text="")), None
    monkeypatch.setattr(audio_events, "request_events", request)
    segments = audio_events.analyze_events(path, raw, directory, lambda: None, lambda _: None)
    assert lengths == [3, 1.5, 1.5]
    assert [s["text"] for s in segments] == [raw[0]["text"]]


def test_exhausted_retries_preserve_asr_without_duplicating_text(audio_system, monkeypatch):
    path, raw, directory, _ = audio_system
    def request(*args):
        raise audio_events.AudioUnavailable("without audio")
    monkeypatch.setattr(audio_events, "request_events", request)
    segments = audio_events.analyze_events(path, raw, directory, lambda: None, lambda _: None)
    assert len(segments) == 1
    assert segments[0]["text"] == raw[0]["text"]
    assert segments[0]["start"] == .2 and segments[0]["end"] == 2.8
    assert segments[0]["analysis_failed"] and segments[0]["issue"]
    assert not list(directory.glob("events-*.json"))


def test_cancel_does_not_become_analysis_failure(audio_system):
    path, raw, directory, _ = audio_system
    def cancel():
        raise media.Cancelled()
    with pytest.raises(media.Cancelled):
        audio_events.analyze_events(path, raw, directory, cancel, lambda _: None)


def test_laughter_never_enters_lexical_aligner(monkeypatch):
    module = ModuleType("whisperx.alignment")
    module.load_align_model = lambda **kw: (object(), {})
    seen = []
    def align(segments, *args, **kw):
        seen.append(segments[0]["text"])
        return {"segments": [{"chars": [
            dict(char=c, start=.2 + i * .1, end=.3 + i * .1, score=.9)
            for i, c in enumerate("こんにちは")]}]}
    module.align = align
    monkeypatch.setitem(sys.modules, "whisperx.alignment", module)
    segments = analysis.initialize_segments([
        dict(start=.2, end=1.2, text="こんにちは"), dict(start=1.8, end=2.8, text="")])
    audio_events.align_speech(segments, np.zeros(48000), lambda: None, lambda _: None)
    assert seen == ["こんにちは"]
    assert segments[0]["end"] == 1.2  # Do not clip the elongated ending.
    assert segments[0]["issue"] is None


def test_schema_is_accepted_by_installed_google_sdk():
    from google.genai import _transformers, types
    # Exercise the actual SDK schema conversion (exclusiveMinimum is unsupported).
    _transformers.t_schema(None, audio_events.Events)
    assert types.Content(role="user", parts=[types.Part.from_text(text="test")]).role == "user"


def test_verification_retries_refusal_instead_of_reporting_no_laughter(tmp_path, monkeypatch):
    from google import genai
    path = tmp_path / "laugh.wav"
    path.write_bytes(b"test-audio")
    replies = iter([
        '{"present":false,"natural":false,"detail":"I cannot directly process audio files."}',
        '{"present":true,"natural":true,"detail":"自然な笑い声"}',
    ])
    calls = []
    def generate(**kw):
        calls.append(kw)
        assert kw["contents"][0].parts[0].inline_data.data == b"test-audio"
        return SimpleNamespace(text=next(replies))
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "test")
    monkeypatch.setattr(genai, "Client", lambda **kw: SimpleNamespace(
        models=SimpleNamespace(generate_content=generate), close=lambda: None))
    monkeypatch.setattr(analysis.time, "sleep", lambda _: None)
    verified = analysis.verify_vocalization(path, "laugh", lambda: None)
    assert verified["present"] and len(calls) == 2


def test_gemini_lexical_text_is_ignored_when_whisper_has_text(audio_system, monkeypatch):
    path, raw, directory, _ = audio_system
    monkeypatch.setattr(audio_events, "request_events", lambda *args: (
        result(event(text="さようなら"), event(start=1.8, end=2.8, text="")), None))
    segments = audio_events.analyze_events(path, raw, directory, lambda: None, lambda _: None)
    assert segments[0]["text"] == raw[0]["text"]
    assert segments[0]["issue"] is None


def test_failed_analysis_recovers_saved_sentence_tail(audio_system, monkeypatch):
    import faster_whisper.vad
    path, raw, directory, aligned = audio_system
    sf.write(path, np.zeros(12 * 16000), 16000)
    raw[:] = [dict(start=5.57, end=10.21,
                   text="これからワールドオブタンクスのゲーム実況を始めていきたいと思います"),
              dict(start=10.21, end=10.948, text="")]
    monkeypatch.setattr(faster_whisper.vad, "get_speech_timestamps", lambda *args: [
        dict(start=round(5.57 * 16000), end=round(10.948 * 16000))])
    def request(*args):
        raise audio_events.AudioUnavailable("without audio")
    monkeypatch.setattr(audio_events, "request_events", request)
    segments = audio_events.analyze_events(path, raw, directory, lambda: None, lambda _: None)
    assert len(segments) == 1
    assert segments[0]["text"] == raw[0]["text"]
    assert segments[0]["end"] == pytest.approx(10.948)
    assert segments[0]["asr_end"] == 10.21
    assert segments[0]["analysis_failed"] and segments[0]["issue"]
    assert len(aligned) == 1 and aligned[0]["end"] == pytest.approx(10.948)
    assert raw[0]["end"] == 10.21  # Retain ASR diagnostics.


@pytest.mark.parametrize("confidence,lexical_end,expected_end,unknown_count", [
    (.9, 2.7, 2.8, 0),  # The recognized word really extends into the old placeholder.
    (.9, 1.9, 2.0, 1),  # Real sound after the word must remain reviewable.
    (0, 2.7, 2.8, 0),   # Uncertain CTC keeps the bounded envelope and warning.
])
def test_failed_speech_is_aligned_before_restoring_unknown_sound(
        monkeypatch, confidence, lexical_end, expected_end, unknown_count):
    module = ModuleType("whisperx.alignment")
    module.load_align_model = lambda **kw: (object(), {})
    seen = []
    def align(segments, *args, **kw):
        seen.append(segments[0]["end"])
        step = (lexical_end - 1) / 4
        return {"segments": [{"chars": [dict(
            char=c, start=1 + i * step, end=1 + (i + 1) * step, score=confidence)
            for i, c in enumerate("思います")]}]}
    module.align = align
    monkeypatch.setitem(sys.modules, "whisperx.alignment", module)
    groups = [dict(start=1, end=2, text="思います", analysis_failed=True, issue="解析失敗"),
              dict(start=2, end=2.8, text="", analysis_failed=True, issue="解析失敗")]
    repaired = audio_events.recover_failed_tails(
        groups, np.zeros(3 * 16000), [dict(start=16000, end=44800)],
        lambda: None, lambda _: None)
    assert seen == [2.8]
    assert repaired[0]["end"] == pytest.approx(expected_end)
    assert repaired[0]["issue"] == "解析失敗"
    assert len([s for s in repaired if not s["text"]]) == unknown_count
    assert bool(repaired[0]["alignment_warning"]) == (confidence == 0)


@pytest.mark.parametrize("following", [
    dict(start=2.3, end=3, text="次です"),
    dict(start=2.3, end=3, text="", expression=event(start=2.3, end=3, text="")),
])
def test_recovered_tail_stops_at_confirmed_next_event(monkeypatch, following):
    monkeypatch.setattr(audio_events, "align_speech", lambda *args: None)
    groups = [dict(start=1, end=2, text="思います", analysis_failed=True),
              dict(start=2, end=2.3, text="", analysis_failed=True), following]
    repaired = audio_events.recover_failed_tails(
        groups, np.zeros(4 * 16000), [dict(start=16000, end=48000)],
        lambda: None, lambda _: None)
    assert repaired[0]["end"] == 2.3
    assert repaired[1] == following


def test_recovered_tail_does_not_absorb_separate_vad_event(monkeypatch):
    monkeypatch.setattr(audio_events, "align_speech", lambda *args: None)
    groups = [dict(start=1, end=2, text="思います", analysis_failed=True),
              dict(start=2.2, end=2.8, text="", analysis_failed=True)]
    repaired = audio_events.recover_failed_tails(
        groups, np.zeros(3 * 16000),
        [dict(start=16000, end=32000), dict(start=35200, end=44800)],
        lambda: None, lambda _: None)
    assert repaired[0]["end"] == 2
    assert len(repaired) == 2 and repaired[1]["start"] == 2.2


def test_failed_windows_restore_one_original_sentence_before_alignment(audio_system, monkeypatch):
    import faster_whisper.vad
    path, raw, directory, aligned = audio_system
    sf.write(path, np.zeros(60 * 16000), 16000)
    text = "出てきてるような、確か院長が乗ってた戦車がヘッザーだった覚えがあります"
    raw[:] = [dict(start=20.48, end=30.27, text=text)]
    monkeypatch.setattr(faster_whisper.vad, "get_speech_timestamps", lambda *args: [
        dict(start=327680, end=432000), dict(start=441984, end=484320)])
    def request(*args):
        raise audio_events.AudioUnavailable("without audio")
    monkeypatch.setattr(audio_events, "request_events", request)
    segments = audio_events.analyze_events(path, raw, directory, lambda: None, lambda _: None)
    assert len(segments) == len(aligned) == 1
    assert (segments[0]["start"], segments[0]["end"], segments[0]["text"]) == (20.48, 30.27, text)
    assert segments[0]["analysis_failed"] and segments[0]["issue"]
    assert segments[0]["id"] == "1"


def test_three_fallback_fragments_merge_without_mutating_inputs():
    groups = [dict(start=i, end=i + 1, text="はい", asr_source_index=0,
                   analysis_failed=True, issue="解析失敗") for i in range(3)]
    result = audio_events.merge_fallback_fragments(groups)
    assert len(result) == 1 and result[0]["start"] == 0 and result[0]["end"] == 3
    assert groups[0]["end"] == 1


@pytest.mark.parametrize("change", [
    {"asr_source_index": 1},  # A real repetition in a different ASR utterance.
    {"asr_source_index": None},  # No evidence that the source is the same.
    {"analysis_failed": False},  # A successful audio event.
    {"start": 1.2},  # Do not bridge unaccounted time.
    {"text": "違う台詞"},
    {"expression": event(start=1, end=2, text="はい")},
])
def test_fallback_merge_preserves_distinct_events(change):
    groups = [dict(start=0, end=1, text="はい", asr_source_index=0, analysis_failed=True),
              dict(start=1, end=2, text="はい", asr_source_index=0, analysis_failed=True)]
    groups[1].update(change)
    assert len(audio_events.merge_fallback_fragments(groups)) == 2


def test_fallback_merge_does_not_cross_a_confirmed_event():
    groups = [dict(start=0, end=1, text="はい", asr_source_index=0, analysis_failed=True),
              dict(start=1, end=2, text="", expression=event(start=1, end=2, text="")),
              dict(start=2, end=3, text="はい", asr_source_index=0, analysis_failed=True)]
    assert len(audio_events.merge_fallback_fragments(groups)) == 3


def test_uncovered_sound_does_not_discard_successful_speech(audio_system, monkeypatch):
    path, raw, directory, _ = audio_system
    calls = []
    def request(client, data, duration, check):
        calls.append(duration)
        if duration < 3:
            raise audio_events.AudioUnavailable("without audio")
        return result(event(text=raw[0]["text"])), None
    monkeypatch.setattr(audio_events, "request_events", request)
    for _ in range(2):
        segments = audio_events.analyze_events(path, raw, directory, lambda: None, lambda _: None)
        assert len(segments) == 1
        assert segments[0]["text"] == raw[0]["text"] and segments[0]["issue"] is None
        assert not segments[0].get("analysis_failed")
        assert segments[0]["end"] == pytest.approx(2.8)
    assert calls.count(3) == 1  # Partial responses are cached and checked again.


def test_mixed_retry_keeps_successful_child_without_copying_full_asr(audio_system, monkeypatch):
    path, raw, directory, _ = audio_system
    calls = []
    def request(*args):
        calls.append(1)
        if len(calls) == 2:
            return result(event(text=raw[0]["text"])), None
        raise audio_events.AudioUnavailable("without audio")
    monkeypatch.setattr(audio_events, "request_events", request)
    segments = audio_events.analyze_events(path, raw, directory, lambda: None, lambda _: None)
    assert len(segments) == 1
    assert segments[0]["text"] == raw[0]["text"]
    assert not segments[0].get("analysis_failed")
    assert segments[0]["issue"] is None


def test_missing_complete_utterance_keeps_asr_only_in_its_gap(audio_system, monkeypatch):
    path, raw, directory, _ = audio_system
    raw[:] = [dict(start=.2, end=1.2, text="こんにちはー"),
              dict(start=1.8, end=2.8, text="次です")]
    def request(client, data, duration, check):
        if duration < 3:
            raise audio_events.AudioUnavailable("without audio")
        return result(event()), None
    monkeypatch.setattr(audio_events, "request_events", request)
    segments = audio_events.analyze_events(path, raw, directory, lambda: None, lambda _: None)
    assert [s["text"] for s in segments] == ["こんにちはー", "次です"]
    assert not segments[0].get("analysis_failed")
    assert segments[1]["analysis_failed"] and segments[1]["issue"]


def test_invalid_nonverbal_timing_warning_is_local():
    groups = audio_events.snap_events(
        [event(start=0, end=.1, text=""), event(), event(start=1.8, end=2.8, text="")],
        [dict(start=3200, end=19200), dict(start=28800, end=44800)], 3)
    reviewed = audio_events.review_acoustic_coverage(
        groups, [dict(start=3200, end=19200), dict(start=28800, end=44800)])
    assert reviewed[0]["analysis_failed"] and "一致" in reviewed[0]["acoustic_warning"]
    assert all(not s.get("analysis_failed") and s["issue"] is None for s in reviewed[1:])


def test_uncertain_fallback_does_not_extend_into_confirmed_noise(monkeypatch):
    monkeypatch.setattr(audio_events, "align_speech", lambda *args: None)
    groups = [dict(start=0, end=1, text="", coverage_gap=True, analysis_failed=True, issue="未判定")]
    localized = audio_events.localize_fallback_text(groups, [dict(start=.2, end=.9, text="台詞")])
    repaired = audio_events.recover_failed_tails(
        localized, np.zeros(32000), [dict(start=0, end=32000)], lambda: None, lambda _: None)
    assert repaired[0]["end"] == 1


def test_partial_retry_keeps_earlier_success_when_both_children_fail():
    good = dict(start=.2, end=1.2, text="こんにちは", expression=event())
    earlier = [good, dict(start=1.8, end=2.8, text="", analysis_failed=True)]
    retried = [dict(start=.2, end=2.8, text="こんにちは次です", analysis_failed=True, issue="失敗")]
    kept = audio_events.preserve_supported_events(earlier, retried)
    assert kept[0] == good
    assert len(kept) == 2 and kept[1]["start"] == 1.2 and kept[1]["text"] == ""
    assert kept[1]["analysis_failed"]


def test_partial_retry_prefers_supported_child_and_keeps_other_success():
    first = dict(start=.2, end=1.2, text="こんにちは", expression=event())
    second = dict(start=1.8, end=2.8, text="次です", expression=event(start=1.8, end=2.8, text="次です"))
    retried = [dict(start=.2, end=1.2, text="仮の台詞", analysis_failed=True), second]
    assert audio_events.preserve_supported_events([first], retried) == [first, second]


def test_partial_retry_does_not_restore_confirmed_lip_noise():
    good = dict(start=.2, end=1.2, text="こんにちは", expression=event())
    retried = [dict(start=.2, end=2.8, text="仮の台詞", analysis_failed=True)]
    kept = audio_events.preserve_supported_events(
        [good], retried, [dict(start=1.2, end=2.8)])
    assert kept == [good]
