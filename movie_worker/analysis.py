import gc
import json
import math
import os
import re
import time
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from . import config, media

MIN_UNEXPLAINED_SECONDS = 0.5
# Hint at verbatim Japanese speech; never insert these words into the result.
# hotwords is repeated at every decoding window, unlike initial_prompt when
# condition_on_previous_text=False. Keep the user's glossary as initial_prompt.
ASR_FILLER_HINT = "あー、えー、えっと、そのー、あのー、うーん。"


def load_alignment_model():
    """Apply the Japanese HF model's required per-clip input normalization.

    WhisperX calls the HF model directly, bypassing the feature extractor.
    Without this step quiet recordings produce mostly blank CTC emissions.
    """
    from whisperx.alignment import load_align_model

    model, metadata = load_align_model(language_code="ja", device="cpu")
    if metadata.get("type") != "huggingface":
        return model, metadata

    def normalized(waveform):
        import torch

        centered = waveform - waveform.mean(dim=-1, keepdim=True)
        variance = waveform.var(dim=-1, keepdim=True, unbiased=False)
        return model(centered / torch.sqrt(variance + 1e-7))

    return normalized, metadata


def short_unexplained(segment):
    """Suppress brief unclassified sounds, without dropping words or known effects."""
    return (not segment.get("text", "").strip()
            and segment.get("vocalization") in (None, "none", "other")
            and segment["end"] - segment["start"] < MIN_UNEXPLAINED_SECONDS)


def group_words(words, duration, max_seconds=20):
    """Boundaries follow aligned tokens and pauses, never an arbitrary clock tick."""
    groups, current = [], []
    for word in words:
        if not word.get("word", "").strip():
            continue
        if "start" not in word or "end" not in word:
            if current:
                current[-1]["word"] += word["word"]
                if re.search(r"\w", word["word"]):
                    current[-1]["unaligned"] = True
            elif groups:
                groups[-1]["text"] += word["word"]
                groups[-1]["issue"] = "時刻を特定できない文字があります。"
            else:
                # Preserve leading unaligned text as a reviewable event.
                groups.append(
                    dict(
                        start=0.0,
                        end=min(duration, 0.3),
                        text=word["word"],
                        issue="時刻を特定できない文字があります。",
                    )
                )
            continue
        start, end = float(word["start"]), float(word["end"])
        if not (
            math.isfinite(start)
            and math.isfinite(end)
            and 0 <= start < end <= duration + 0.1
        ):
            raise ValueError("文字起こしの発言時刻が不正です。")
        split = current and (
            start - current[-1]["end"] >= 0.3
            or end - current[0]["start"] > max_seconds
            or re.search(r"[。！？!?]$", current[-1]["word"])
        )
        if split:
            groups.append(pack(current))
            current = []
        current.append(
            dict(
                word=word["word"],
                start=start,
                end=min(end, duration),
                unaligned=word.get("unaligned", False),
            )
        )
    if current:
        groups.append(pack(current))
    return groups


def pack(words):
    issue = (
        "時刻を特定できない文字があります。"
        if any(w.get("unaligned") for w in words)
        else None
    )
    return dict(
        start=words[0]["start"],
        end=words[-1]["end"],
        text="".join(w["word"] for w in words).strip(),
        issue=issue,
    )


def alignment_windows(transcript, vad, duration, max_extension=1.0):
    """Give CTC room to find a word ending underestimated by Whisper.

    Only extend within the same detected speech event. Stop before the next
    transcript, and bound the correction so a long event cannot absorb later
    speech. Keep the original transcript timestamps for diagnostics.
    """
    result = []
    for index, segment in enumerate(transcript):
        end = segment["end"]
        limit = min(
            duration,
            end + max_extension,
            transcript[index + 1]["start"]
            if index + 1 < len(transcript)
            else duration,
        )
        for event in vad:
            speech_start, speech_end = event["start"] / 16000, event["end"] / 16000
            if speech_start < end < speech_end:
                end = max(end, min(speech_end, limit))
                break
        result.append({**segment, "end": end})
    return result


def unexplained_speech(groups, vad):
    """Keep genuinely uncovered speech after alignment has checked the tails."""
    extra = []
    ordered = sorted(groups, key=lambda s: s["start"])
    for event in vad:
        start, end = event["start"] / 16000, event["end"] / 16000
        cursor = start
        for segment in ordered:
            if segment["end"] <= cursor or segment["start"] >= end:
                continue
            if segment["start"] - cursor >= MIN_UNEXPLAINED_SECONDS:
                extra.append((cursor, segment["start"]))
            cursor = max(cursor, segment["end"])
        if end - cursor >= MIN_UNEXPLAINED_SECONDS:
            extra.append((cursor, end))
    return [
        dict(
            start=start,
            end=end,
            text="",
            issue="文字にならない発声、または聞き取りが必要な区間です。",
        )
        for start, end in extra
    ]


def transcribe(path, directory, check, report, glossary=""):
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    report("実況を文字起こししています（初回はモデルを取得します）。")
    audio = decode_audio(str(path), sampling_rate=16000)
    vad = get_speech_timestamps(
        audio,
        VadOptions(
            min_silence_duration_ms=300, speech_pad_ms=100, min_speech_duration_ms=80
        ),
    )
    check()
    model = WhisperModel(
        config.ASR_MODEL,
        device="cpu",
        compute_type="int8",
        cpu_threads=max(1, min(8, (os.cpu_count() or 4) - 2)),
    )
    result, _ = model.transcribe(
        str(path),
        language="ja",
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=300, min_speech_duration_ms=80),
        initial_prompt=glossary or None,
        hotwords=ASR_FILLER_HINT,
        condition_on_previous_text=False,
    )
    raw = []
    for s in result:
        check()
        if s.text.strip():
            raw.append(dict(start=s.start, end=s.end, text=s.text, words=[
                dict(word=w.word, start=w.start, end=w.end, probability=w.probability)
                for w in (s.words or [])
            ]))
            report(f"文字起こし中：{s.end:.0f}秒まで確認しました。")
    del model
    gc.collect()
    (directory / "transcript.json").write_text(
        json.dumps(raw, ensure_ascii=False), encoding="utf-8"
    )
    # Classify speech and vocal effects before attempting lexical alignment.
    return initialize_segments(raw + unexplained_speech(raw, vad))


def align_transcript(raw, audio, vad, check, report):
    """Align a transcript without repeating ASR, including for saved jobs."""
    groups = []
    if raw:
        report("日本語の発言と音声の時刻を合わせています。")
        from whisperx.alignment import align

        aligner, metadata = load_alignment_model()
        try:
            for seg in alignment_windows(raw, vad, len(audio) / 16000):
                check()
                aligned = align(
                    [seg], aligner, metadata, audio, "cpu", return_char_alignments=True
                )
                chars = [c for item in aligned["segments"] for c in item.get("chars", [])]
                problem = alignment_problem(chars, seg)
                if problem:
                    groups.append({**seg, "issue": problem, "timing_source": "asr_fallback"})
                    continue
                words = [
                    {"word": c.get("char", ""), **{
                        k: c[k] for k in ("start", "end") if c.get(k) is not None
                    }} for c in chars
                ]
                # Never rejoin separate input events across their boundary.
                groups.extend(group_words(japanese_words(words), len(audio) / 16000))
        finally:
            del aligner
            gc.collect()
    groups.extend(unexplained_speech(groups, vad))
    return initialize_segments(groups)


def alignment_problem(chars, segment):
    lexical = [c for c in chars if re.search(r"\w", c.get("char", ""))]
    timed = [c for c in lexical if c.get("start") is not None and c.get("end") is not None]
    scores = [c["score"] for c in timed if c.get("score") is not None]
    if (not timed or len(timed) < len(lexical) * 0.8
        or (scores and sum(s < 0.1 for s in scores) >= len(scores) / 2)
        or timed[-1]["end"] - timed[0]["start"] < len(timed) * 0.035
        or timed[-1]["end"] - timed[0]["start"] < (segment["end"] - segment["start"]) * 0.2):
        return "文字と音声の時刻を十分な確度で照合できません。原音の区間を保持しています。"
    return None


def initialize_segments(groups):
    groups.sort(key=lambda s: s["start"])
    previous = 0.0
    for i, seg in enumerate(groups):
        seg.setdefault("issue", None)
        if seg["start"] < previous:
            seg["issue"] = (
                "発言時刻が重なっています。開始・終了時刻を確認してください。"
            )
        previous = max(previous, seg["end"])
        seg.update(
            id=str(i + 1),
            reading=seg["text"],
            emotion="neutral",
            style="normal",
            strength=0.5,
            mode="tts",
            status="pending",
            attempts=0,
            revision=0,
            nonverbal=not bool(seg["text"]),
        )
    return groups


class Expression(BaseModel):
    id: str
    emotion: Literal[
        "neutral", "joy", "surprise", "anger", "fear", "sadness", "confusion", "relief", "unknown"
    ]
    style: Literal["normal", "whisper", "shout", "laugh", "cry", "breathy", "rushed"]
    strength: float = Field(ge=0, le=1)
    suggested_text: str = Field(max_length=2000)
    emphasis: str = Field(max_length=150)
    pace: Literal["slow", "normal", "fast"]
    nonverbal: bool
    vocalization: Literal[
        "none", "laugh", "scream", "sigh", "cry", "gasp", "breath", "cough", "other"
    ] = "none"
    uncertainty: str = Field(max_length=500)


class Analysis(BaseModel):
    segments: list[Expression]


def windows(segments, span=60):
    result, current = [], []
    for seg in segments:
        if current and seg["end"] - current[0]["start"] > span:
            result.append(current)
            current = []
        current.append(seg)
    if current:
        result.append(current)
    return result


def expressions(source, segments, directory, check, save):
    from .audio_events import analyze_events

    refined = analyze_events(source, segments, directory, check, lambda msg: save(segments, msg))
    # Commit all new IDs together; cancellation never saves half-renumbered segments.
    segments[:] = refined
    save(segments, "台詞・発声と感情の解析が完了しました。")


def apply_expression(segment, result):
    vocalization = result.vocalization
    if result.nonverbal and vocalization == "none":
        vocalization = {
            "laugh": "laugh",
            "shout": "scream",
            "cry": "cry",
            "breathy": "breath",
        }.get(result.style, "other")
    segment.update(
        emotion=result.emotion,
        style=result.style,
        strength=result.strength,
        emphasis=result.emphasis,
        pace=result.pace,
        nonverbal=result.nonverbal,
        vocalization=vocalization,
        suggested_text=result.suggested_text,
    )
    if result.nonverbal and vocalization in config.VOCALIZATIONS:
        # A recognized vocal effect resolves the placeholder issue created for
        # VAD speech that has no lexical transcript.
        segment["issue"] = None
    if result.uncertainty:
        segment["issue"] = result.uncertainty[:500]
    # Whisper is the sole source of lexical content. Gemini's suggested_text
    # is replaced with that text before this function is called; do not create
    # a second transcription comparison or warning here.


def validate_expressions(result, segments):
    ids = [s.id for s in result.segments]
    if len(ids) != len(set(ids)) or set(ids) != {s["id"] for s in segments}:
        raise ValueError("Geminiの発言IDが一致しません。")
    for s in result.segments:
        if (
            s.emotion not in config.EMOTIONS
            or s.style not in config.STYLES
            or len(s.suggested_text) > 2000
            or s.pace not in {"slow", "normal", "fast"}
            or s.vocalization not in {"none", *config.VOCALIZATIONS, "other"}
        ):
            raise ValueError("Geminiの感情解析に不正な値があります。")


def normalize(text):
    import unicodedata

    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", text)).lower()


def japanese_words(chars):
    """CTC aligns characters; Sudachi restores Japanese word boundaries."""
    from sudachipy import dictionary

    tokenizer = dictionary.Dictionary().create()
    text = "".join(c["word"] for c in chars)
    # CTC sometimes supplies whole fallback segments. Keep those for review.
    if any(len(c["word"]) != 1 for c in chars):
        return chars
    result = []
    for token in tokenizer.tokenize(text):
        span = chars[token.begin() : token.end()]
        timed = [c for c in span if "start" in c and "end" in c]
        entry = dict(word=token.surface())
        if timed:
            entry.update(
                start=timed[0]["start"],
                end=timed[-1]["end"],
                unaligned=any(
                    "start" not in c and re.search(r"\w", c["word"]) for c in span
                ),
            )
        result.append(entry)
    return result


class VocalizationCheck(BaseModel):
    present: bool
    natural: bool
    detail: str = Field(max_length=300)


def verify_vocalization(path, expected, check):
    """Use the same configured Gemini service to verify generated vocal effects."""
    from google import genai
    from google.genai import types
    from .audio_events import AudioUnavailable, require_audio_understanding

    labels = {
        "laugh": "笑い声",
        "scream": "悲鳴・叫び声",
        "sigh": "ため息",
        "cry": "泣き声・嗚咽",
        "gasp": "息をのむ音",
        "breath": "息遣い",
        "cough": "咳・咳払い",
    }
    client = genai.Client(
        vertexai=True,
        project=os.environ["GOOGLE_CLOUD_PROJECT"],
        location=os.environ.get("GOOGLE_CLOUD_LOCATION", "global"),
        http_options=types.HttpOptions(timeout=120000),
    )
    try:
        for attempt in range(4):
            check()
            try:
                response = client.models.generate_content(
                    model=config.GEMINI_MODEL,
                    contents=[types.Content(role="user", parts=[
                        types.Part.from_bytes(data=Path(path).read_bytes(), mime_type="audio/wav"),
                        types.Part.from_text(text=f"添付した生成音声を実際に聴いて検査します。{labels[expected]}が実際に聞こえればpresent=true、不自然な破綻や無音ではなく発声として成立していればnatural=trueにしてください。台詞と混ざっていても構いません。"),
                    ])],
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        response_schema=VocalizationCheck,
                        temperature=0,
                        thinking_config=(types.ThinkingConfig(thinking_budget=0)
                                         if config.GEMINI_MODEL.startswith("gemini-2.5-flash") else None),
                    ),
                )
                result = VocalizationCheck.model_validate_json(response.text)
                require_audio_understanding(result.detail)
                return result.model_dump()
            except Exception as exc:
                if attempt == 3 or not (isinstance(exc, AudioUnavailable) or any(
                    code in str(exc) for code in ("429", "500", "502", "503", "504")
                )):
                    raise ValueError("生成した非言語発声を確認できませんでした。") from exc
                for _ in range(2**attempt * 10):
                    check()
                    time.sleep(0.5)
    finally:
        client.close()
        gc.collect()
