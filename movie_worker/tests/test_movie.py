import hashlib
import io

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient
from safetensors.numpy import save

from movie_worker import analysis, media, pipeline, server
from movie_worker.store import Store

OWNER = "anon_" + "a" * 32
OTHER = "anon_" + "b" * 32


def tone(seconds, frequency=220, sr=48000):
    return (
        0.05 * np.sin(2 * np.pi * frequency * np.arange(round(seconds * sr)) / sr)
    ).astype("float32")


@pytest.fixture
def system(tmp_path, monkeypatch):
    store = Store(tmp_path)
    engine = pipeline.Engine(store)
    monkeypatch.setattr(server, "store", store)
    monkeypatch.setattr(server, "engine", engine)
    monkeypatch.setattr(server.config, "DATA", tmp_path)
    client = TestClient(
        server.app,
        headers={"Authorization": "Bearer " + server.TOKEN, "X-Movie-Owner": OWNER},
    )
    return store, engine, client


@pytest.fixture
def movie(tmp_path):
    path = tmp_path / "test.mp4"
    media.ffmpeg(
        [
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=160x90:r=10:d=4",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=4",
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
            path,
        ]
    )
    return path


def test_audio_diagnostics_are_owner_scoped_and_downloadable(system):
    from movie_worker import audio_diagnostics
    store, _, client = system
    job = store.create(OWNER, "diagnostics.mp4", 100)
    url = f"/jobs/{job['id']}/audio-diagnostics"
    download = f"/jobs/{job['id']}/files/{audio_diagnostics.LOG_NAME}"
    assert client.get(url).json() == dict(available=False, entries=[], truncated=False)
    assert client.get(download).status_code == 404
    record = '{"request_id":"test","outcome":"failed","error":{"code":504}}\n'
    (store.directory(job["id"]) / audio_diagnostics.LOG_NAME).write_bytes(record.encode("utf-8"))
    response = client.get(url)
    assert response.json()["entries"][0]["error"]["code"] == 504
    assert response.headers["cache-control"] == "private, no-store"
    response = client.get(download)
    assert response.text == record and response.headers["content-disposition"].startswith("attachment;")
    assert response.headers["content-type"] == "application/x-ndjson"
    with (store.directory(job["id"]) / audio_diagnostics.LOG_NAME).open("ab") as file:
        file.write(b'{"request_id":')
    # A download while the worker is writing includes complete records only.
    response = client.get(download)
    assert response.text == record
    assert int(response.headers["content-length"]) == len(response.content)
    for path in (url, download):
        assert client.get(path, headers={"X-Movie-Owner": OTHER}).status_code == 404
        assert client.get(path, headers={"Authorization": "Bearer invalid"}).status_code == 401
    store.patch(job["id"], state="expired")
    assert client.get(url).status_code == 404 and client.get(download).status_code == 404


def make_segment(ident="1", start=0.5, end=1.5):
    return dict(
        id=ident,
        start=start,
        end=end,
        text="テストです。",
        reading="テストです。",
        emotion="neutral",
        style="normal",
        strength=0.5,
        mode="tts",
        status="pending",
        issue=None,
        attempts=0,
        revision=0,
        nonverbal=False,
        vocalization="none",
    )


def test_utterances_follow_pause_and_punctuation():
    words = [
        dict(word="こんにちは。", start=0.1, end=1),
        dict(word="えっ", start=1.1, end=1.4),
        dict(word="危ない", start=2, end=2.9),
    ]
    segments = analysis.group_words(words, 4)
    assert [s["text"] for s in segments] == ["こんにちは。", "えっ", "危ない"]
    assert segments[2]["start"] == 2


def test_unaligned_text_is_preserved():
    segments = analysis.group_words(
        [dict(word="はい", start=0.1, end=0.4), dict(word="未整列"), dict(word="。")], 1
    )
    assert segments[0]["text"] == "はい未整列。"
    assert segments[0]["issue"]


def test_model_response_ids_and_labels():
    item = dict(
        id="1",
        emotion="joy",
        style="normal",
        strength=0.5,
        suggested_text="はい",
        emphasis="",
        pace="normal",
        nonverbal=False,
        uncertainty="",
    )
    analysis.validate_expressions(
        analysis.Analysis(segments=[analysis.Expression(**item)]), [{"id": "1"}]
    )
    with pytest.raises(ValueError):
        analysis.validate_expressions(
            analysis.Analysis(segments=[analysis.Expression(**item)]), [{"id": "2"}]
        )
    with pytest.raises(ValueError):
        analysis.validate_expressions(
            analysis.Analysis(
                segments=[analysis.Expression(**{**item, "emotion": "invented"})]
            ),
            [{"id": "1"}],
        )


def test_gemini_response_schema_constrains_allowed_values():
    # Gemini must receive the same choices that the worker accepts, rather than
    # unconstrained strings that can pass schema generation and fail afterwards.
    fields = analysis.Analysis.model_json_schema()["$defs"]["Expression"]["properties"]
    assert set(fields["emotion"]["enum"]) == set(analysis.config.EMOTIONS)
    assert set(fields["style"]["enum"]) == set(analysis.config.STYLES)
    assert set(fields["pace"]["enum"]) == {"slow", "normal", "fast"}
    assert set(fields["vocalization"]["enum"]) == {
        "none", "laugh", "scream", "sigh", "cry", "gasp", "breath", "cough", "other"
    }
    assert fields["suggested_text"]["maxLength"] == 2000


@pytest.mark.parametrize(
    "field,value",
    [("style", "excited"), ("pace", "rushed"), ("suggested_text", "a" * 2001)],
)
def test_model_response_rejects_invalid_expression_fields(field, value):
    item = dict(
        id="1", emotion="joy", style="normal", strength=0.5,
        suggested_text="はい", emphasis="", pace="normal",
        nonverbal=False, uncertainty="",
    )
    with pytest.raises(ValueError):
        analysis.Expression.model_validate({**item, field: value})


def test_upload_resume_auth_and_mismatched_retry(system):
    store, engine, client = system
    response = client.post("/uploads", json={"name": "test.mp4", "size": 8})
    ident = response.json()["id"]
    assert (
        client.put(f"/uploads/{ident}?offset=0", content=b"abcd").json()["received"]
        == 4
    )
    assert (
        client.put(f"/uploads/{ident}?offset=0", content=b"abcd").json()["received"]
        == 4
    )
    assert client.put(f"/uploads/{ident}?offset=0", content=b"XXXX").status_code == 409
    assert (
        client.get(f"/jobs/{ident}", headers={"X-Movie-Owner": OTHER}).status_code
        == 404
    )
    assert (
        client.get("/jobs", headers={"Authorization": "Bearer bad"}).status_code == 401
    )
    assert client.post(f"/uploads/{ident}/complete").status_code == 400
    assert client.put(f"/uploads/{ident}?offset=4", content=b"efgh").status_code == 200
    assert (store.directory(ident) / "input.mp4").read_bytes() == b"abcdefgh"
    client.post(f"/uploads/{ident}/complete")
    client.post(f"/jobs/{ident}/cancel")
    assert store.get(ident)["state"] == "cancelled"
    assert client.post(f"/jobs/{ident}/resume").status_code == 200


def test_no_cumulative_drift_and_output_mix(movie, tmp_path):
    directory = tmp_path / "render"
    directory.mkdir()
    (directory / "input.mp4").write_bytes(movie.read_bytes())
    info = media.inspect(movie)
    assert len(info["audio"]) == 2
    media.extract(movie, directory / "game.wav", 1, info["origin"], 4, lambda: None)
    media.extract(
        movie, directory / "commentary-source.wav", 2, info["origin"], 4, lambda: None
    )
    segments = [make_segment("1", 0.5, 1.5), make_segment("2", 2.5, 3.5)]
    for s in segments:
        sf.write(directory / f"seg-{s['id']}.wav", tone(1), 48000)
        s["status"] = "done"
    job = dict(media=info, segments=segments, game_gain=1, voice_gain=1)
    media.mix(job, directory, lambda: None)
    output = media.probe(directory / "output.mp4")
    assert len([s for s in output["streams"] if s["codec_type"] == "audio"]) == 1
    audio, sr = sf.read(directory / "commentary.wav")
    assert len(audio) == 4 * 48000
    assert np.max(np.abs(audio[48000 * 2 : 120000])) == 0
    # Decoded final mix contains game + replacement; original 880Hz is absent.
    media.ffmpeg(["-i", directory / "output.mp4", "-vn", directory / "final.wav"])
    mixed, _ = sf.read(directory / "final.wav", always_2d=True)
    spectrum = np.abs(np.fft.rfft(mixed[30000:78000, 0]))
    assert spectrum[220] > 20 and spectrum[440] > 20
    assert spectrum[880] < min(spectrum[220], spectrum[440]) * 0.05


def test_legacy_original_mode_is_silent_in_export(tmp_path):
    directory = tmp_path / "render"
    directory.mkdir()
    sf.write(directory / "commentary-source.wav", tone(1, frequency=880), 48000)
    segment = make_segment("1", 0, 1)
    segment["mode"] = "original"
    media.timeline({"media": {"duration": 1}, "segments": [segment]}, directory, lambda: None)
    rendered, rate = sf.read(directory / "commentary.wav")
    assert rate == 48000
    assert len(rendered) == 48000
    assert np.max(np.abs(rendered)) == 0


@pytest.mark.parametrize("source_seconds,target_seconds", [(2, 0.5), (0.5, 2)])
def test_fit_matches_large_fast_and_slow_timing_differences(
    tmp_path, source_seconds, target_seconds
):
    source = tmp_path / "source.wav"
    target = tmp_path / "fit.wav"
    sf.write(source, tone(source_seconds), 48000)
    media.fit_audio(source, target, target_seconds)
    fitted, rate = sf.read(target)
    assert len(fitted) == round(target_seconds * rate)
    assert np.max(np.abs(fitted)) > 0.01


def test_nonverbal_synthesis_uses_irodori_emoji_controls():
    segment = make_segment()
    segment.update(reading="", text="", nonverbal=True, vocalization="laugh")
    assert pipeline.synthesis_input(segment) == "🤭🤭"
    segment.update(reading="やった")
    assert pipeline.synthesis_input(segment) == "やった🤭"


def test_recognized_laughter_resolves_untranscribed_speech_issue():
    segment = make_segment()
    segment.update(text="", reading="", issue="文字にならない発声です。")
    result = analysis.Expression(
        id="1",
        emotion="joy",
        style="laugh",
        strength=0.8,
        suggested_text="笑い声",
        emphasis="",
        pace="normal",
        nonverbal=True,
        vocalization="none",
        uncertainty="",
    )
    analysis.apply_expression(segment, result)
    assert segment["issue"] is None
    assert segment["vocalization"] == "laugh"


def test_failed_pure_laughter_falls_back_to_silence_never_original():
    segment = make_segment()
    segment.update(text="", reading="", nonverbal=True, vocalization="laugh")
    pipeline.settle_synthesis_failure(segment, "笑い声を生成できませんでした。", "laugh")
    assert segment["mode"] == "mute"
    assert segment["status"] == "accepted"
    assert segment["issue"] is None
    assert "original" not in segment.values()


def test_recognized_laughter_can_be_saved_without_reading(system):
    store, _, client = system
    job = store.create(OWNER, "laugh.mp4", 1)
    segment = make_segment()
    segment.update(text="", reading="", nonverbal=True, vocalization="laugh")
    store.patch(job["id"], state="needs_review", media={"duration": 4}, segments=[segment])
    response = client.patch(f"/jobs/{job['id']}/segments/1", json=dict(
        revision=0, text="", reading="", start=.5, end=1.5,
        emotion="joy", style="laugh", mode="tts", accept=True))
    assert response.status_code == 200
    assert response.json()["segments"][0]["reading"] == ""


def test_segment_overlap_and_stale_revision(system):
    store, engine, client = system
    job = store.create(OWNER, "video.mp4", 4)
    store.patch(
        job["id"],
        state="needs_review",
        media={"duration": 4},
        segments=[make_segment(), make_segment("2", 2, 3)],
    )
    body = dict(
        revision=0,
        text="はい",
        reading="はい",
        start=0.5,
        end=2.1,
        emotion="neutral",
        style="normal",
        mode="tts",
        accept=True,
    )
    path = f"/jobs/{job['id']}/segments/1"
    assert client.patch(path, json=body).status_code == 400
    body["end"] = 1.5
    body["mode"] = "original"
    assert client.patch(path, json=body).status_code == 400
    body["mode"] = "tts"
    assert client.patch(path, json=body).status_code == 200
    assert client.patch(path, json=body).status_code == 409


def test_accepting_exhausted_segment_allows_retry(system):
    store, _, client = system
    job = store.create(OWNER, "retry.mp4", 1)
    segment = make_segment()
    segment.update(status="review", attempts=3, issue="読みが一致しません",
                   analysis_failed=True, analysis_issue="expression_missing")
    store.patch(job["id"], state="needs_review", media={"duration": 4}, segments=[segment])
    body = {k: segment[k] for k in (
        "revision", "text", "reading", "start", "end", "emotion", "style", "mode")}
    response = client.patch(f"/jobs/{job['id']}/segments/1", json={**body, "accept": True})
    assert response.status_code == 200
    saved = response.json()["segments"][0]
    assert saved["attempts"] == 0 and saved["status"] == "pending"
    assert saved["issue"] is None and saved["revision"] == 1
    assert not saved["analysis_failed"] and saved["analysis_issue"] is None


def test_source_excerpt_tracks_recovered_revision(system, monkeypatch):
    store, _, client = system
    job = store.create(OWNER, "source.mp4", 1)
    segment = make_segment()
    store.patch(job["id"], state="needs_review", segments=[segment])
    intervals = []
    def excerpt(source, destination, start, end):
        intervals.append((start, end))
        destination.write_bytes(b"excerpt")
    monkeypatch.setattr(media, "excerpt", excerpt)
    url = f"/jobs/{job['id']}/files/source-1.wav"
    assert client.get(url).status_code == 200
    assert client.get(url).status_code == 200
    segment.update(start=.7, revision=1)
    store.patch(job["id"], segments=[segment])
    assert client.get(url).status_code == 200
    assert intervals == [(.5, 1.5), (.7, 1.5)]


def test_full_pipeline_with_ai_stubs_and_real_ffmpeg(system, movie, monkeypatch):
    import faster_whisper

    def unexpected_asr(*args, **kwargs):
        pytest.fail("Generated audio must not be transcribed again")

    monkeypatch.setattr(faster_whisper, "WhisperModel", unexpected_asr)
    monkeypatch.setattr(
        analysis,
        "verify_vocalization",
        lambda *args: {"present": True, "natural": True, "detail": "fixture"},
    )
    store, engine, client = system
    ident = client.post(
        "/uploads", json={"name": "test.mp4", "size": movie.stat().st_size}
    ).json()["id"]
    client.put(f"/uploads/{ident}?offset=0", content=movie.read_bytes())
    client.post(f"/uploads/{ident}/complete")
    engine.perform(ident, "inspect")
    assert store.get(ident)["state"] == "ready"
    data = save({"speaker_embedding": np.ones((2, 4), dtype=np.float32)})

    def snapshot(owner, directory):
        path = directory / "voice.speaker.safetensors"
        path.write_bytes(data)
        return dict(
            snapshot_path=str(path),
            voice={"hash": hashlib.sha256(data).hexdigest()},
            tts_fingerprint={"model": {}, "checkpoint": "fixture"},
        )

    monkeypatch.setattr(pipeline, "snapshot", snapshot)
    monkeypatch.setattr(
        pipeline, "fingerprint", lambda owner: {"model": {}, "checkpoint": "fixture"}
    )
    laugh = make_segment("2", 2, 3)
    laugh.update(text="", reading="", nonverbal=True, vocalization="laugh", style="laugh")
    monkeypatch.setattr(analysis, "transcribe", lambda *args: [make_segment(), laugh])
    monkeypatch.setattr(
        analysis,
        "expressions",
        lambda source, segments, directory, check, save: save(segments, "fixture"),
    )
    wav = io.BytesIO()
    # The synthesizer may return natural speech longer than the source segment.
    sf.write(wav, tone(2), 48000, format="WAV")

    class Speech:
        status_code = 200
        content = wav.getvalue()

        def raise_for_status(self):
            pass

    speech_requests = []

    def speech(*args, **kwargs):
        speech_requests.append(kwargs["json"])
        return Speech()

    monkeypatch.setattr(pipeline.httpx, "post", speech)
    assert (
        client.post(
            f"/jobs/{ident}/analyze",
            json={"game_index": 1, "voice_index": 2},
        ).status_code
        == 200
    )
    engine.perform(ident, "analyze")
    assert store.get(ident)["state"] == "preview_ready"
    assert store.get(ident)["segments"][0]["status"] == "done"
    assert "seconds" not in speech_requests[0]["irodori"]
    fitted, rate = sf.read(store.directory(ident) / "seg-1.wav")
    assert rate == 48000 and len(fitted) == 48000
    assert (
        client.post(f"/jobs/{ident}/convert", json={"confirmed": False}).status_code
        == 400
    )
    assert (
        client.post(f"/jobs/{ident}/convert", json={"confirmed": True}).status_code
        == 200
    )
    engine.perform(ident, "convert")
    assert store.get(ident)["state"] == "completed"
    assert speech_requests[0]["input"] == "テストです。"
    assert len(speech_requests) == 2
    assert "error_rate" not in store.get(ident)["segments"][0]["quality"]
    assert speech_requests[1]["input"] == "🤭🤭"
    assert speech_requests[1]["irodori"]["caption"].endswith("自然な笑い声を含める。")
    assert store.get(ident)["segments"][1]["quality"]["vocalization"]["natural"]
    assert (
        client.get(
            f"/jobs/{ident}/files/output.mp4", headers={"Range": "bytes=0-31"}
        ).status_code
        == 206
    )
    assert (
        client.get(f"/jobs/{ident}/files/voice.speaker.safetensors").status_code == 404
    )
    assert (
        client.get(
            f"/jobs/{ident}/files/output.mp4", headers={"X-Movie-Owner": OTHER}
        ).status_code
        == 404
    )
    stopped = store.get(ident)["segments"]
    stopped[0].update(status="review", issue=pipeline.LEGACY_READING_ISSUE,
                      attempts=3, quality={"transcript": "誤認識", "error_rate": .9})
    store.patch(ident, state="needs_review", segments=stopped)
    assert client.post(f"/jobs/{ident}/convert", json={"confirmed": True}).status_code == 200
    engine.perform(ident, "convert")
    assert store.get(ident)["state"] == "completed"
    assert store.get(ident)["segments"][0]["issue"] is None
    assert len(speech_requests) == 2  # Reuse the already generated audio.
    # A saved analysis warning must recover during Continue, without asking
    # for row-by-row acceptance or synthesizing the finished neighbor again.
    from movie_worker import speech_recovery
    import faster_whisper.vad
    stopped = store.get(ident)["segments"]
    stopped[0].update(status="review", issue=speech_recovery.REVIEW_ISSUE,
                      analysis_failed=True, attempts=0,
                      aligned_start=.5, aligned_end=1.5, alignment_warning=None)
    neighbor_audio = (store.directory(ident) / "seg-2.wav").read_bytes()
    monkeypatch.setattr(faster_whisper.vad, "get_speech_timestamps", lambda *args: [
        dict(start=8000, end=24000), dict(start=32000, end=48000)])
    monkeypatch.setattr(speech_recovery, "request_review", lambda data, seg, check, diagnostics=None:
        speech_recovery.SpeechReview(id=seg["id"], audio_understood=True,
            content="confirmed", expression_confident=False, emotion="unknown",
            style="normal", strength=.5, pace="normal", vocalization="none", reason="感情のみ不明"))
    store.patch(ident, state="needs_review", segments=stopped)
    assert client.post(f"/jobs/{ident}/convert", json={"confirmed": True}).status_code == 200
    engine.perform(ident, "convert")
    recovered = store.get(ident)
    assert recovered["state"] == "completed"
    assert recovered["segments"][0]["analysis_resolution"]["method"] == "neutral_expression"
    assert len(speech_requests) == 3
    assert (store.directory(ident) / "seg-2.wav").read_bytes() == neighbor_audio
    assert client.delete(f"/jobs/{ident}").status_code == 200
    assert not store.directory(ident).exists()


def test_cancel_stops_ffmpeg(tmp_path):
    def cancel():
        raise media.Cancelled()

    with pytest.raises(media.Cancelled):
        media.ffmpeg(
            ["-f", "lavfi", "-i", "sine=duration=600", "-f", "null", "-"], cancel
        )


def test_store_survives_restart(tmp_path):
    store = Store(tmp_path)
    job = store.create(OWNER, "test.mp4", 5)
    store.patch(job["id"], state="synthesizing", segments=[make_segment()])
    assert (
        Store(tmp_path).get(job["id"], OWNER)["segments"][0]["text"] == "テストです。"
    )
    with pytest.raises(KeyError):
        Store(tmp_path).get(job["id"], OTHER)


def test_cleanup_preserves_active_jobs_and_retries_deleted_files(system):
    store, engine, _ = system
    old = store.create(OWNER, "old.mp4", 1)
    active = store.create(OWNER, "active.mp4", 1)
    store.patch(active["id"], state="analyzing")
    # Model an expired record without sleeping for the retention period.
    store.patch(old["id"], state="expired")
    engine.cleanup()
    assert not store.directory(old["id"]).exists()
    assert store.directory(active["id"]).exists()


@pytest.mark.parametrize("audio_state,expected", [
    ("valid", "done"), ("missing", "pending"), ("truncated", "pending"),
    ("silent", "pending"), ("corrupt", "pending"),
])
def test_old_reading_review_reuses_audio_or_allows_generation(tmp_path, audio_state, expected):
    segment = make_segment()
    segment.update(status="review", issue=pipeline.LEGACY_READING_ISSUE, attempts=3,
                   quality={"transcript": "誤認識", "error_rate": .9})
    path = tmp_path / "seg-1.wav"
    if audio_state == "corrupt":
        path.write_bytes(b"invalid wav")
    elif audio_state != "missing":
        samples = np.zeros(48000) if audio_state == "silent" else tone(.5 if audio_state == "truncated" else 1)
        sf.write(path, samples, 48000)
    assert pipeline.recover_reading_review(segment, tmp_path)
    assert segment["status"] == expected and segment["issue"] is None
    assert segment["attempts"] == 0 and segment["quality"] == {}


def test_other_review_reasons_are_not_cleared(tmp_path):
    segment = make_segment()
    segment.update(status="review", issue="発言時刻が重なっています。", attempts=3)
    before = dict(segment)
    assert not pipeline.recover_reading_review(segment, tmp_path)
    assert segment == before
