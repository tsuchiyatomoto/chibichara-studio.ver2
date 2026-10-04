import sys
from types import ModuleType

import numpy as np
import pytest

from movie_worker import analysis, audio_events


def vad(start, end):
    return dict(start=round(start * 16000), end=round(end * 16000))


def test_japanese_alignment_normalizes_each_clip_like_feature_extractor(monkeypatch):
    import torch
    from transformers import Wav2Vec2FeatureExtractor

    module = ModuleType("whisperx.alignment")
    seen = []
    module.load_align_model = lambda **kw: (lambda waveform: seen.append(waveform),
                                          {"type": "huggingface"})
    monkeypatch.setitem(sys.modules, "whisperx.alignment", module)
    model, _ = analysis.load_alignment_model()
    for samples in (np.linspace(-.003, .006, 16000, dtype=np.float32),
                    np.zeros(16000, dtype=np.float32)):
        original = torch.from_numpy(samples.copy()).unsqueeze(0)
        model(original)
        expected = Wav2Vec2FeatureExtractor()(samples, sampling_rate=16000).input_values[0]
        np.testing.assert_allclose(seen[-1].numpy()[0], expected, atol=1e-6)
        np.testing.assert_array_equal(original.numpy()[0], samples)


def stub_alignment(monkeypatch, chars):
    module = ModuleType("whisperx.alignment")
    module.load_align_model = lambda **kw: (object(), {})
    module.align = lambda *args, **kw: {"segments": [{"chars": chars}]}
    monkeypatch.setitem(sys.modules, "whisperx.alignment", module)


def test_short_speech_after_long_silence_uses_acoustic_duration(monkeypatch):
    chars = [dict(char=c, start=15 + i * .1, end=15.1 + i * .1, score=.9)
             for i, c in enumerate("マジか")]
    stub_alignment(monkeypatch, chars)
    segments = [dict(start=0, end=15.8, text="マジか", issue=None)]
    audio_events.align_speech(segments, np.zeros(16 * 16000), lambda: None,
                             lambda _: None, [vad(1, 1.5), vad(14.95, 15.8)])
    assert len(segments) == 1
    assert segments[0]["issue"] is None
    assert segments[0]["start"] == pytest.approx(14.95)
    assert segments[0]["end"] == pytest.approx(15.8)
    assert segments[0]["text"] == "マジか"


def test_long_ctc_blank_does_not_stretch_sentence_across_pause():
    # CTC includes six silent seconds in the final vowel before the next word.
    chars = [dict(char="は", start=1, end=1.2), dict(char="い", start=1.2, end=8),
             dict(char="次", start=8, end=8.3), dict(char="で", start=8.3, end=8.5),
             dict(char="す", start=8.5, end=8.6)]
    groups = audio_events.aligned_speech_groups(
        chars, dict(start=.8, end=9), [vad(.9, 1.7), vad(7.9, 8.9)], 10)
    assert [g["text"] for g in groups] == ["はい", "次です"]
    assert groups[0]["end"] == pytest.approx(1.7)
    assert groups[1]["start"] == pytest.approx(7.9)


def test_low_confidence_speech_still_requires_review(monkeypatch):
    chars = [dict(char=c, start=1 + i * .1, end=1.1 + i * .1, score=0)
             for i, c in enumerate("マジか")]
    stub_alignment(monkeypatch, chars)
    segments = [dict(start=.9, end=1.6, text="マジか", issue=None)]
    audio_events.align_speech(segments, np.zeros(32000), lambda: None,
                             lambda _: None, [vad(.9, 1.6)])
    assert segments[0]["issue"]
    assert segments[0]["start"] == .9 and segments[0]["end"] == 1.6


def test_one_expression_can_cover_two_transcript_sentences():
    event = audio_events.Event(start=1, end=4, suggested_text="東へ行っても意味ない",
        emotion="neutral", style="normal", strength=.5, emphasis="", pace="normal",
        nonverbal=False, vocalization="none", uncertainty="")
    sources = [dict(start=1, end=2, text="東へ行っても"),
               dict(start=2, end=4, text="意味ない")]
    groups = audio_events.canonicalize_transcript_events([
        dict(start=1, end=4, text=event.suggested_text, expression=event)], sources, 5)
    assert all(not g.get("analysis_failed") for g in groups)
    assert [g["expression"].suggested_text for g in groups] == [s["text"] for s in sources]
    assert event.suggested_text == "東へ行っても意味ない"


def test_confident_alignment_outside_detected_speech_requires_review(monkeypatch):
    chars = [dict(char=c, start=5 + i * .1, end=5.1 + i * .1, score=.9)
             for i, c in enumerate("マジか")]
    stub_alignment(monkeypatch, chars)
    segments = [dict(start=0, end=8, text="マジか", issue=None)]
    audio_events.align_speech(segments, np.zeros(9 * 16000), lambda: None,
                             lambda _: None, [vad(1, 2)])
    assert segments[0]["issue"]
    assert segments[0]["start"] == 0 and segments[0]["end"] == 8
