import hashlib
import os
import shutil
import threading
import time
from pathlib import Path

import httpx
import numpy as np
import soundfile as sf
from safetensors.numpy import load as load_tensors

from . import analysis, config, media
from .store import ACTIVE


# Only used to migrate jobs stopped by the removed second transcription.
LEGACY_READING_ISSUE = "生成音声の読みが台詞と大きく異なります。読みや感情を調整して再生成してください。"


def recover_reading_review(segment, directory):
    if (segment.get("issue") != LEGACY_READING_ISSUE
            or segment.get("status") != "review" or segment.get("mode") != "tts"):
        return False
    quality = segment.get("quality") or {}
    segment["quality"] = {k: v for k, v in quality.items()
                          if k not in {"transcript", "error_rate"}}
    segment.update(issue=None, status="pending", attempts=0)
    try:
        audio, rate = sf.read(directory / f"seg-{segment['id']}.wav", dtype="float32")
        frames = round(segment["end"] * 48000) - round(segment["start"] * 48000)
        valid = (rate == 48000 and audio.ndim == 1 and len(audio) == frames
                 and np.isfinite(audio).all() and np.any(np.abs(audio) > .001))
    except (OSError, RuntimeError, ValueError):
        valid = False
    vocalization = quality.get("vocalization", {})
    if vocalization_kind(segment) in config.VOCALIZATIONS:
        valid = valid and vocalization.get("present") and vocalization.get("natural")
    if valid:
        segment["status"] = "done"
    return True


def tts_headers(owner):
    headers = {"X-Irodori-Owner-ID": owner}
    if os.environ.get("IRODORI_TTS_API_KEY"):
        headers["Authorization"] = "Bearer " + os.environ["IRODORI_TTS_API_KEY"]
    return headers


def tts_get(path, owner):
    response = httpx.get(config.TTS + path, headers=tts_headers(owner), timeout=30)
    response.raise_for_status()
    return response


def vocalization_kind(segment):
    kind = segment.get("vocalization", "none")
    if kind in config.VOCALIZATIONS:
        return kind
    if not segment.get("nonverbal"):
        return "none"
    return {
        "laugh": "laugh",
        "shout": "scream",
        "cry": "cry",
        "breathy": "breath",
    }.get(segment.get("style"), "other")


def synthesis_input(segment):
    reading = segment.get("reading", "").strip()
    kind = vocalization_kind(segment)
    control = config.VOCALIZATIONS.get(kind)
    if not control:
        return reading
    return reading + control["suffix"] if reading else control["input"]


def settle_synthesis_failure(segment, message, vocalization):
    if segment.get("nonverbal") and vocalization in config.VOCALIZATIONS:
        segment.update(
            mode="mute",
            status="accepted",
            issue=None,
            fallback_reason=message,
        )
        return
    segment.update(
        status="review",
        issue=message
        or segment.get("issue")
        or "再試行回数の上限です。読み・感情を調整して再生成してください。",
    )


def fingerprint(owner):
    health = tts_get("/health", owner).json()
    model = health["model"]
    if model.get("model_precision") != "fp32" or model.get("codec_precision") != "fp32":
        raise ValueError(
            "Movieの品質基準はモデル・CodecともにFP32です。音声サーバーの設定を確認してください。"
        )
    checkpoint = health.get("runtime", {}).get("checkpoint")
    identity = dict(model=model, checkpoint=checkpoint)
    if checkpoint and Path(checkpoint).is_file():
        stat = Path(checkpoint).stat()
        identity.update(bytes=stat.st_size, modified=stat.st_mtime_ns)
    return identity


def snapshot(owner, directory):
    # The server copies under its asset lock: replacement cannot remove half-read data.
    for attempt in range(3):
        assets = tts_get("/v1/audio/speaker-assets", owner).json()["data"]
        if not assets:
            raise ValueError("Voiceで声を学習・保存してからMovieを開始してください。")
        latest = max(assets, key=lambda a: (a["created_at"], a["id"]))
        response = httpx.get(
            config.TTS + f"/v1/audio/voice-assets/{latest['id']}/content",
            headers=tts_headers(owner),
            timeout=30,
        )
        if response.status_code == 404:
            if attempt < 2:
                continue
            raise ValueError(
                "声モデルを固定できません。音声サーバーのMovie拡張と再起動を確認してください。"
            )
        response.raise_for_status()
        data = response.content
        if not 0 < len(data) <= 10 * 1024**2 or len(data) != latest["bytes"]:
            raise ValueError("保存済み声モデルのサイズが一致しません。")
        tensors = load_tensors(data)
        embedding = tensors.get("speaker_embedding")
        if embedding is None or embedding.ndim != 2 or not np.isfinite(embedding).all():
            raise ValueError("保存済み声モデルの値が不正です。")
        target = directory / "voice.speaker.safetensors"
        target.write_bytes(data)
        return dict(
            snapshot_path=str(target),
            voice=dict(
                id=latest["id"],
                hash=hashlib.sha256(data).hexdigest(),
                created=latest["created_at"],
            ),
            tts_fingerprint=fingerprint(owner),
        )
    raise ValueError("声モデルを固定できませんでした。")


class Engine:
    def __init__(self, store):
        self.store = store
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.thread = None

    def start(self):
        # A process-wide OS lock in server lifespan excludes a second worker.
        for job in self.store.list():
            if job["state"] in ACTIVE:
                state = "cancelled" if job["state"] == "cancelling" else "queued"
                self.store.patch(
                    job["id"], state=state, message="中断した工程から再開します。"
                )
        self.thread = threading.Thread(
            target=self.loop, daemon=True, name="movie-worker"
        )
        self.thread.start()

    def check(self, ident):
        if self.stop.is_set() or self.store.get(ident)["state"] == "cancelling":
            raise media.Cancelled()

    def queue(self, ident, task):
        self.store.patch(
            ident,
            state="queued",
            task=task,
            error=None,
            message="処理開始を待っています。",
        )
        self.wake.set()

    def loop(self):
        while not self.stop.is_set():
            self.cleanup()
            pending = [j for j in self.store.list() if j["state"] == "queued"]
            if not pending:
                self.wake.wait(2)
                self.wake.clear()
                continue
            with self.store.lock:
                job = self.store.get(min(pending, key=lambda j: j["updated"])["id"])
                if job["state"] != "queued":
                    continue
                ident = job["id"]
                self.store.patch(
                    ident,
                    state="validating" if job["task"] == "inspect" else "analyzing",
                )
            try:
                self.perform(ident, job["task"])
            except media.Cancelled:
                self.store.patch(
                    ident,
                    state="queued" if self.stop.is_set() else "cancelled",
                    message="処理を中止しました。",
                )
            except Exception as exc:
                # Detailed errors stay on the owner-scoped job, never include credentials.
                message = str(exc)[:1400]
                self.store.patch(
                    ident,
                    state="failed",
                    error=message,
                    message="処理を完了できませんでした。原因を確認して再開できます。",
                )

    def cleanup(self):
        now = time.time()
        for candidate in self.store.list():
            # Recheck under the same lock used by resume/edit/upload before deleting.
            with self.store.lock:
                job = self.store.get(candidate["id"])
                if job["state"] in ACTIVE or (
                    job["state"] != "expired"
                    and now - job["updated"] < config.RETENTION
                ):
                    continue
                directory = self.store.directory(job["id"]).resolve()
                if (
                    directory.parent != self.store.root.resolve()
                    or directory.is_symlink()
                ):
                    continue
                if directory.exists():
                    try:
                        shutil.rmtree(directory)
                    except OSError:
                        # Windows may keep a playback handle open. Retry next sweep.
                        continue
                if job["state"] != "expired":
                    self.store.patch(
                        job["id"],
                        state="expired",
                        segments=[],
                        message="保存期限が終了しました。",
                    )

    def progress(self, ident, message, **fields):
        with self.store.lock:
            self.check(ident)
            self.store.patch(ident, message=message, **fields)

    def perform(self, ident, task):
        job = self.store.get(ident)
        directory = self.store.directory(ident)
        check = lambda: self.check(ident)
        report = lambda message: self.progress(ident, message)
        if task == "inspect":
            self.progress(
                ident, "動画と音声トラックを確認しています。", state="validating"
            )
            info = media.inspect(directory / "input.mp4", check)
            for track in info["audio"]:
                media.ffmpeg(
                    [
                        "-i",
                        directory / "input.mp4",
                        "-map",
                        f"0:{track['index']}",
                        "-t",
                        "30",
                        "-vn",
                        "-c:a",
                        "aac",
                        "-b:a",
                        "128k",
                        directory / f"track-{track['index']}.m4a",
                    ],
                    check,
                )
            self.store.patch(
                ident,
                media=info,
                game_index=info["audio"][0]["index"],
                voice_index=info["audio"][1]["index"],
                state="ready",
                message="ゲーム音と実況を試聴して、割り当てを確認してください。",
            )
            return
        if task == "analyze":
            self.progress(ident, "声モデルを固定しています。", state="analyzing")
            if not job.get("snapshot_path"):
                self.store.patch(ident, **snapshot(job["owner"], directory))
            job = self.store.get(ident)
            if not (directory / "extracted.json").exists():
                report("ゲーム音と実況を抽出しています。")
                info = job["media"]
                media.extract(
                    directory / "input.mp4",
                    directory / "game.wav",
                    job["game_index"],
                    info["origin"],
                    info["duration"],
                    check,
                )
                media.extract(
                    directory / "input.mp4",
                    directory / "commentary-stereo.wav",
                    job["voice_index"],
                    info["origin"],
                    info["duration"],
                    check,
                )
                warning = media.mono(
                    directory / "commentary-stereo.wav",
                    directory / "commentary-source.wav",
                )
                media.ffmpeg(
                    [
                        "-i",
                        directory / "commentary-source.wav",
                        "-ar",
                        "16000",
                        "-ac",
                        "1",
                        directory / "analysis.wav",
                    ],
                    check,
                )
                (directory / "extracted.json").write_text("{}")
                self.store.patch(ident, warning=warning)
            if not job.get("transcribed"):
                segments = analysis.transcribe(
                    directory / "analysis.wav",
                    directory,
                    check,
                    report,
                    job.get("glossary", ""),
                )
                if not segments:
                    raise ValueError(
                        "実況の発声が見つかりません。トラックを確認してください。"
                    )
                self.store.patch(ident, segments=segments, transcribed=True)
            segments = self.store.get(ident)["segments"]
            analysis.expressions(
                directory / "analysis.wav",
                segments,
                directory,
                check,
                lambda ss, msg: self.progress(ident, msg, segments=ss),
            )
            self.store.patch(ident, analyzed=True, gemini_model=config.GEMINI_MODEL)
            # Include representative emotions; never gate on only neutral speech.
            chosen, seen = [], set()
            for seg in sorted(segments, key=lambda s: bool(s["issue"])):
                if (
                    not seg["issue"]
                    and (seg["text"] or (seg.get("nonverbal") and vocalization_kind(seg) in config.VOCALIZATIONS))
                    and seg["end"] - seg["start"] >= 0.5
                    and (seg["emotion"] not in seen or not chosen)
                ):
                    chosen.append(seg["id"])
                    seen.add(seg["emotion"])
                if len(chosen) == 3:
                    break
            if not chosen:
                self.store.patch(
                    ident,
                    state="needs_review",
                    message="読みを指定して、短い発言を再生成してください。",
                )
                return
            self.store.patch(ident, preview_ids=chosen)
            self.synthesize(ident, chosen, preview=True)
            return
        if task in {"convert", "preview", "regenerate"}:
            if task == "convert":
                from .speech_recovery import needs_recovery, recover_segments
                if any(needs_recovery(s) for s in job["segments"]):
                    self.progress(ident, "未解決の発言を自動で再確認しています。", state="analyzing")
                    recover_segments(directory / "analysis.wav", job["segments"], directory, check, report)
                    self.store.patch(ident, segments=job["segments"])
            ids = (
                [s["id"] for s in job["segments"]]
                if task == "convert"
                else (
                    job.get("regenerate_ids", [])
                    if task == "regenerate"
                    else job.get("preview_ids", [])
                )
            )
            self.synthesize(ident, ids, preview=task != "convert")
            if task != "convert":
                return
            job = self.store.get(ident)
            unresolved = [s for s in job["segments"] if
                s["status"] not in {"done", "accepted"} or s["issue"]
            ]
            if unresolved:
                first = unresolved[0]
                reason = first.get("issue") or "音声を生成できていません。"
                self.store.patch(
                    ident,
                    state="needs_review",
                    message=f"確認が必要な発言が{len(unresolved)}件あります。"
                    f"最初の箇所（{first['start']:.1f}秒）：{reason}",
                )
                return
        if task in {"convert", "mix"}:
            job = self.store.get(ident)
            self.progress(
                ident, "ゲーム音と実況を合成してMP4を書き出しています。", state="mixing"
            )
            media.mix(job, directory, check)
            self.progress(
                ident,
                "変換が完了しました。MP4をダウンロードできます。",
                state="completed",
                progress=100,
                error=None,
            )

    def synthesize(self, ident, ids, preview):
        job = self.store.get(ident)
        directory = self.store.directory(ident)
        if (
            hashlib.sha256(Path(job["snapshot_path"]).read_bytes()).hexdigest()
            != job["voice"]["hash"]
        ):
            raise ValueError(
                "固定した声モデルが変更されています。新しいジョブを作成してください。"
            )
        self.progress(ident, "実況を生成しています。", state="synthesizing")
        segments = job["segments"]
        for index, seg in enumerate(segments):
            self.check(ident)
            if seg["id"] not in ids:
                continue
            if recover_reading_review(seg, directory):
                self.store.patch(ident, segments=segments)
            if seg["status"] == "done":
                continue
            if seg["mode"] != "tts":
                seg.update(status="accepted", issue=None)
            elif (seg["issue"] and not preview) or not synthesis_input(seg):
                seg["status"] = "review"
            else:
                # Issue remains visible until the user explicitly accepts/edits it.
                last = None
                vocalization = vocalization_kind(seg)
                for attempt in range(seg.get("attempts", 0), 3):
                    self.check(ident)
                    if fingerprint(job["owner"]) != job["tts_fingerprint"]:
                        raise ValueError(
                            "音声サーバーのモデル設定が変わりました。元の設定に戻して再開してください。"
                        )
                    seed = (
                        int(
                            hashlib.sha256(
                                f"{ident}:{seg['id']}:{seg['revision']}:{attempt}".encode()
                            ).hexdigest()[:8],
                            16,
                        )
                        % 2147483647
                    )
                    caption = (
                        config.EMOTIONS[seg["emotion"]]
                        + "で、"
                        + config.STYLES[seg["style"]]
                        + "。"
                    )
                    if seg["strength"] < 0.4 or attempt == 2:
                        caption = "感情を控えめに、" + caption
                    elif seg["strength"] >= 0.75:
                        caption = "感情が伝わるように、" + caption
                    if seg.get("pace") == "slow":
                        caption += "少しゆっくり話す。"
                    elif seg.get("pace") == "fast" and seg["style"] != "rushed":
                        caption += "少し早口で話す。"
                    emphasis = seg.get("emphasis", "")
                    if emphasis and emphasis in seg["reading"]:
                        caption += f"「{emphasis[:150]}」を少し強調する。"
                    if vocalization in config.VOCALIZATIONS:
                        caption += config.VOCALIZATIONS[vocalization]["caption"] + "。"
                    options = dict(
                        ref_embed=job["snapshot_path"],
                        caption=caption,
                        # Let the checkpoint allocate enough frames to speak. The
                        # generated speech is fitted to the exact timeline below.
                        num_steps=40,
                        num_candidates=1,
                        decode_mode="sequential",
                        chunking_enabled=False,
                        seed=seed,
                    )
                    try:
                        self.progress(
                            ident,
                            f"発言 {index + 1}/{len(segments)} を生成しています。",
                            progress=round(index / max(1, len(segments)) * 90),
                        )
                        # Do not abort an in-flight GPU request; the server's gate owns it.
                        for busy in range(360):
                            self.check(ident)
                            response = httpx.post(
                                config.TTS + "/v1/audio/speech",
                                headers=tts_headers(job["owner"]),
                                json=dict(
                                    model=os.environ.get(
                                        "IRODORI_TTS_MODEL", "irodori-tts"
                                    ),
                                    input=synthesis_input(seg),
                                    response_format="wav",
                                    irodori=options,
                                ),
                                timeout=httpx.Timeout(None, connect=10),
                            )
                            if response.status_code not in {409, 429, 503}:
                                break
                            if response.status_code == 503:
                                readiness = (
                                    tts_get("/health", job["owner"])
                                    .json()
                                    .get("speaker_inversion", {})
                                )
                                if not readiness.get("busy") and not readiness.get(
                                    "training"
                                ):
                                    response.raise_for_status()
                            self.progress(
                                ident, "Voiceの学習・生成が終わるのを待っています。"
                            )
                            for _ in range(20):
                                self.check(ident)
                                time.sleep(0.5)
                        response.raise_for_status()
                        self.check(ident)
                        if not job["tts_fingerprint"].get("checkpoint"):
                            loaded = fingerprint(job["owner"])
                            if loaded["model"] != job["tts_fingerprint"]["model"]:
                                raise ValueError(
                                    "音声サーバーのモデルが変更されました。"
                                )
                            job["tts_fingerprint"] = loaded
                            self.store.patch(ident, tts_fingerprint=loaded)
                        raw = directory / f"raw-{seg['id']}.wav"
                        raw.write_bytes(response.content)
                        media.fit_audio(
                            raw,
                            directory / f"seg-{seg['id']}.wav",
                            (round(seg["end"] * 48000) - round(seg["start"] * 48000))
                            / 48000,
                            lambda: self.check(ident),
                        )
                        # The first source transcript (or the user's edit) is
                        # authoritative. Never transcribe generated speech again.
                        quality = {}
                        if vocalization in config.VOCALIZATIONS:
                            quality["vocalization"] = analysis.verify_vocalization(
                                directory / f"seg-{seg['id']}.wav",
                                vocalization,
                                lambda: self.check(ident),
                            )
                        seg["quality"] = quality
                        if vocalization in config.VOCALIZATIONS and not (
                            quality["vocalization"]["present"]
                            and quality["vocalization"]["natural"]
                        ):
                            raise ValueError(
                                "生成音声で非言語発声を自然に再現できませんでした。"
                            )
                        seg.update(status="done", attempts=attempt + 1, seed=seed)
                        last = None
                        break
                    except (ValueError, httpx.HTTPStatusError) as exc:
                        last = str(exc)
                        seg["attempts"] = attempt + 1
                if last or seg["status"] != "done":
                    settle_synthesis_failure(seg, last, vocalization)
            self.store.patch(ident, segments=segments)
        if preview:
            self.store.patch(
                ident,
                state="preview_ready",
                message="生成した声を試聴してください。異音や声の違いがないことを確認して全体を変換します。",
            )
