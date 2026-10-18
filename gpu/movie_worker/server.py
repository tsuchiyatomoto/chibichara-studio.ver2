import hashlib
import math
import os
import re
import secrets
import shutil
import struct
from contextlib import asynccontextmanager

import httpx
import portalocker
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from . import audio_diagnostics, config, media
from .pipeline import Engine, tts_get
from .store import ACTIVE, Store

store = Store()
engine = Engine(store)
token_file = config.DATA / "service.token"
if not token_file.exists():
    try:
        with token_file.open("x", encoding="utf-8") as file:
            file.write(secrets.token_urlsafe(48))
        os.chmod(token_file, 0o600)
    except FileExistsError:
        pass
TOKEN = config.TOKEN or token_file.read_text(encoding="utf-8").strip()


@asynccontextmanager
async def lifespan(app):
    # Keep this lock until all in-flight GPU calls have returned on shutdown.
    with portalocker.Lock(str(config.DATA / "worker.lock"), timeout=0):
        engine.start()
        try:
            yield
        finally:
            engine.stop.set()
            engine.wake.set()
            if engine.thread:
                engine.thread.join()


def owner(authorization: str = Header(""), x_movie_owner: str = Header("")):
    if not secrets.compare_digest(authorization, "Bearer " + TOKEN):
        raise HTTPException(401, "認証が必要です。")
    if not re.fullmatch(r"anon_[a-f0-9]{32}", x_movie_owner):
        raise HTTPException(401, "所有者を確認できません。")
    return x_movie_owner


app = FastAPI(
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    dependencies=[Depends(owner)],
)


@app.exception_handler(KeyError)
async def missing(request, exc):
    return JSONResponse({"error": "ジョブが見つかりません。"}, status_code=404)


@app.exception_handler(ValueError)
async def invalid(request, exc):
    return JSONResponse({"error": str(exc)}, status_code=400)


@app.exception_handler(httpx.HTTPError)
async def upstream(request, exc):
    return JSONResponse(
        {"error": "音声サーバーに接続できません。起動状態を確認してください。"},
        status_code=503,
    )


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Upload(Body):
    name: str = Field(min_length=1, max_length=200)
    size: int = Field(gt=0, le=config.MAX_BYTES)


class Analyze(Body):
    # Accepted for compatibility with workers and browser tabs started before
    # tracks were fixed. The endpoint always uses the first two audio streams.
    game_index: int | None = None
    voice_index: int | None = None
    glossary: str = Field(default="", max_length=2000)


class Convert(Body):
    confirmed: bool = True
    game_gain: float = Field(default=1, ge=0, le=2)
    voice_gain: float = Field(default=1, ge=0, le=2)


class SegmentEdit(Body):
    revision: int
    text: str = Field(max_length=1000)
    reading: str = Field(max_length=1000)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    emotion: str
    style: str
    mode: str
    accept: bool = False


class AvatarPlacement(Body):
    x: float = Field(ge=-3, le=4)
    y: float = Field(ge=-3, le=4)
    scale: float = Field(ge=0.05, le=3)
    rotation: float = Field(ge=-180, le=180)
    flip_x: bool = False


class AvatarPose(Body):
    id: str = Field(min_length=1, max_length=40, pattern=r"^[a-zA-Z0-9_-]+$")
    label: str = Field(min_length=1, max_length=100)
    frames: tuple[str, str, str, str]


class AvatarBody(Body):
    placement: AvatarPlacement
    poses: list[AvatarPose] = Field(min_length=1, max_length=3)


def idle(job):
    if job["state"] in ACTIVE or job["state"] in {"uploading", "expired"}:
        raise HTTPException(
            409, "処理中または期限切れです。処理終了後に操作してください。"
        )


@app.get("/health")
def health(oid=Depends(owner)):
    try:
        voices = tts_get("/v1/audio/speaker-assets", oid).json().get("data", [])
        tts_ready, error = True, None
    except httpx.HTTPError:
        voices, tts_ready, error = [], False, "音声サーバーに接続できません。"
    return dict(
        status="ok",
        tts_ready=tts_ready,
        voice_available=bool(voices),
        error=error
        or (
            None
            if config.gemini_configured()
            else "Geminiのプロジェクト・認証ファイルを確認してください。"
        ),
        max_bytes=config.MAX_BYTES,
        chunk_bytes=config.CHUNK_BYTES,
        gemini_configured=config.gemini_configured(),
    )


@app.get("/jobs")
def jobs(oid=Depends(owner)):
    return {
        "jobs": [store.public(j) for j in store.list(oid) if j["state"] != "expired"]
    }


@app.post("/uploads", status_code=201)
def create_upload(body: Upload, oid=Depends(owner)):
    if not body.name.lower().endswith(".mp4"):
        raise ValueError("MP4ファイルを選択してください。")
    with store.lock:
        if len([j for j in store.list(oid) if j["state"] != "expired"]) >= 5:
            raise HTTPException(
                409, "保存中の動画が5本あります。不要な動画を削除してください。"
            )
        reserved = sum(
            max(0, j["size"] - j["received"])
            for j in store.list()
            if j["state"] == "uploading"
        )
        if shutil.disk_usage(config.DATA).free < body.size * 3 + reserved + 2 * 1024**3:
            raise HTTPException(
                507, "動画と中間音声を保存する空き容量が不足しています。"
            )
        return store.public(store.create(oid, body.name, body.size))


@app.get("/jobs/{ident}")
def job_status(ident: str, oid=Depends(owner)):
    return store.public(store.get(ident, oid))


@app.get("/jobs/{ident}/audio-diagnostics")
def job_audio_diagnostics(ident: str, oid=Depends(owner)):
    job = store.get(ident, oid)
    if job["state"] == "expired":
        raise KeyError(ident)
    return JSONResponse(audio_diagnostics.read_recent(store.directory(ident)),
                        headers={"Cache-Control": "private, no-store"})


@app.put("/uploads/{ident}")
async def upload_chunk(ident: str, request: Request, offset: int, oid=Depends(owner)):
    store.get(ident, oid)
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > config.CHUNK_BYTES:
            raise HTTPException(413, "チャンクが大きすぎます。")
        data.extend(chunk)
    if not data or offset < 0:
        raise ValueError("アップロード位置またはデータが不正です。")
    digest = hashlib.sha256(data).hexdigest()
    with store.edit(ident, oid) as job:
        if job["state"] != "uploading":
            raise HTTPException(409, "この動画のアップロードは終了しています。")
        known = job.setdefault("upload_chunks", {}).get(str(offset))
        if known == [len(data), digest]:
            return {"received": job["received"]}
        if offset != job["received"] or offset + len(data) > job["size"]:
            raise HTTPException(
                409, "アップロード位置が一致しません。再開してください。"
            )
        path = store.directory(ident) / "input.mp4"
        with path.open("r+b" if path.exists() else "wb") as target:
            target.seek(offset)
            target.write(data)
            target.truncate()
            target.flush()
            os.fsync(target.fileno())
        job["received"] += len(data)
        job["upload_chunks"][str(offset)] = [len(data), digest]
        return {"received": job["received"]}


@app.post("/uploads/{ident}/complete")
def complete_upload(ident: str, oid=Depends(owner)):
    with store.lock:
        job = store.get(ident, oid)
        if job["state"] != "uploading":
            return store.public(job)
        if job["received"] != job["size"]:
            raise ValueError("アップロードが完了していません。")
        engine.queue(ident, "inspect")
    return store.public(store.get(ident, oid))


@app.put("/jobs/{ident}/avatar-assets/{name}")
async def upload_avatar_asset(
    ident: str, name: str, request: Request, oid=Depends(owner)
):
    job = store.get(ident, oid)
    idle(job)
    if job["state"] != "ready":
        raise HTTPException(409, "アバターは動画の確認中に設定してください。")
    if not re.fullmatch(r"avatar-[0-2]-[0-3]\.png", name):
        raise ValueError("アバター画像の名前が不正です。")
    if request.headers.get("content-type", "").split(";", 1)[0].strip() != "image/png":
        raise HTTPException(415, "PNG画像を送信してください。")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > 12 * 1024**2:
            raise HTTPException(413, "アバター画像が大きすぎます。")
        data.extend(chunk)
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError("正しいPNG画像を送信してください。")
    width, height = struct.unpack(">II", data[16:24])
    if not 1 <= width <= 4096 or not 1 <= height <= 4096:
        raise ValueError("アバター画像は4096px以下にしてください。")
    target = store.directory(ident) / name
    temporary = target.with_suffix(".part")
    temporary.write_bytes(data)
    os.replace(temporary, target)
    return {"name": name, "width": width, "height": height}


@app.post("/jobs/{ident}/avatar")
def configure_avatar(ident: str, body: AvatarBody, oid=Depends(owner)):
    with store.lock:
        job = store.get(ident, oid)
        idle(job)
        if job["state"] != "ready":
            raise HTTPException(409, "アバターは動画の確認中に設定してください。")
        referenced = [name for pose in body.poses for name in pose.frames]
        if len(set(referenced)) != len(referenced) or any(
            not re.fullmatch(r"avatar-[0-2]-[0-3]\.png", name)
            for name in referenced
        ):
            raise ValueError("アバター画像の構成が不正です。")
        directory = store.directory(ident)
        if any(not (directory / name).is_file() for name in referenced):
            raise ValueError("アバター画像が不足しています。")
        digest = hashlib.sha256(ident.encode("ascii"))
        for name in referenced:
            digest.update(name.encode("ascii"))
            digest.update((directory / name).read_bytes())
        avatar = body.model_dump()
        avatar["seed"] = int.from_bytes(digest.digest()[:4], "big")
        for path in directory.glob("avatar-*.png"):
            if path.name not in referenced:
                path.unlink(missing_ok=True)
        for name in ("avatar-animation.json", "avatar.ffconcat", "avatar-scale.cmd", "output.mp4", "preview.mp4"):
            (directory / name).unlink(missing_ok=True)
        store.patch(ident, avatar=avatar)
    return store.public(store.get(ident, oid))


@app.post("/jobs/{ident}/analyze")
def analyze(ident: str, body: Analyze, oid=Depends(owner)):
    with store.lock:
        job = store.get(ident, oid)
        idle(job)
        if job["state"] != "ready":
            raise HTTPException(
                409,
                "解析は入力確認後に開始してください。失敗した場合は再開を使用してください。",
            )
        if not config.gemini_configured():
            raise ValueError("Geminiのプロジェクト・認証ファイルを確認してください。")
        if shutil.disk_usage(config.DATA).free < job["size"] + 2 * 1024**3:
            raise HTTPException(507, "変換用の空き容量が不足しています。")
        store.patch(
            ident,
            game_index=job["media"]["audio"][0]["index"],
            voice_index=job["media"]["audio"][1]["index"],
            glossary=body.glossary,
        )
        engine.queue(ident, "analyze")
    return store.public(store.get(ident, oid))


@app.post("/jobs/{ident}/convert")
def convert(ident: str, body: Convert, oid=Depends(owner)):
    with store.lock:
        job = store.get(ident, oid)
        idle(job)
        if not job.get("analyzed") or not job.get("snapshot_path"):
            raise ValueError("先に解析と試聴を行ってください。")
        store.patch(
            ident,
            confirmed=True,
            game_gain=body.game_gain,
            voice_gain=body.voice_gain,
        )
        engine.queue(ident, "convert")
    return store.public(store.get(ident, oid))


@app.patch("/jobs/{ident}/segments/{segment_id}")
def edit_segment(ident: str, segment_id: str, body: SegmentEdit, oid=Depends(owner)):
    with store.lock:
        job = store.get(ident, oid)
        idle(job)
        segments = job["segments"]
        seg = next((s for s in segments if s["id"] == segment_id), None)
        if not seg:
            raise KeyError(segment_id)
        if seg["revision"] != body.revision:
            raise HTTPException(
                409, "別の画面で発言が更新されています。再読み込みしてください。"
            )
        if (
            not math.isfinite(body.start + body.end)
            or not 0.08 <= body.end - body.start <= 30
            or body.end > job["media"]["duration"]
        ):
            raise ValueError(
                "発言の開始・終了時刻を確認してください（長さ0.08〜30秒）。"
            )
        if any(
            s["id"] != segment_id and body.start < s["end"] and body.end > s["start"]
            for s in segments
        ):
            raise ValueError("隣の発言と時間が重なっています。")
        if (
            body.emotion not in config.EMOTIONS
            or body.style not in config.STYLES
            or body.mode not in {"tts", "mute"}
        ):
            raise ValueError("感情・話し方・区間の扱いが不正です。")
        if (body.mode == "tts" and not body.reading.strip()
            and not (seg.get("nonverbal") and seg.get("vocalization") in config.VOCALIZATIONS)):
            raise ValueError("読みを入力してください。")
        same = all(
            seg.get(k) == v
            for k, v in body.model_dump(exclude={"revision", "accept"}).items()
        )
        if not same:
            seg.update(body.model_dump(exclude={"accept"}))
            seg.update(
                revision=seg["revision"] + 1, status="pending", attempts=0, issue=None
            )
            for name in (f"seg-{segment_id}.wav", f"source-{segment_id}.wav"):
                (store.directory(ident) / name).unlink(missing_ok=True)
        elif body.accept:
            seg["issue"] = None
            if seg["status"] == "review":
                # Accepting a failed attempt must actually allow another try.
                # Otherwise range(attempts, 3) stays empty on every conversion.
                seg.update(status="pending", attempts=0, revision=seg["revision"] + 1)
        if not same or body.accept:
            seg.update(analysis_failed=False, analysis_issue=None)
            seg.pop("analysis_detail", None)
        if body.mode != "tts":
            seg.update(status="accepted", issue=None)
        segments.sort(key=lambda s: s["start"])
        (store.directory(ident) / "output.mp4").unlink(missing_ok=True)
        store.patch(
            ident,
            segments=segments,
            state="preview_ready",
            message="発言を更新しました。全体変換へ進めます。",
        )
    return store.public(store.get(ident, oid))


@app.post("/jobs/{ident}/segments/{segment_id}/regenerate")
def regenerate(ident: str, segment_id: str, oid=Depends(owner)):
    with store.lock:
        job = store.get(ident, oid)
        idle(job)
        seg = next((s for s in job["segments"] if s["id"] == segment_id), None)
        if not seg:
            raise KeyError(segment_id)
        seg.update(status="pending", attempts=0, revision=seg["revision"] + 1)
        (store.directory(ident) / "output.mp4").unlink(missing_ok=True)
        store.patch(ident, segments=job["segments"], regenerate_ids=[segment_id])
        engine.queue(ident, "regenerate")
    return store.public(store.get(ident, oid))


@app.post("/jobs/{ident}/cancel")
def cancel(ident: str, oid=Depends(owner)):
    with store.lock:
        job = store.get(ident, oid)
        if job["state"] in ACTIVE:
            store.patch(
                ident,
                state="cancelled" if job["state"] == "queued" else "cancelling",
                message="実行中の処理の終了を待って中止します。",
            )
    return store.public(store.get(ident, oid))


@app.post("/jobs/{ident}/resume")
def resume(ident: str, oid=Depends(owner)):
    with store.lock:
        job = store.get(ident, oid)
        if job["state"] not in {"failed", "cancelled"} or not job.get("task"):
            raise HTTPException(409, "この状態からは再開できません。")
        engine.queue(ident, job["task"])
    return store.public(store.get(ident, oid))


@app.delete("/jobs/{ident}")
def delete(ident: str, oid=Depends(owner)):
    with store.lock:
        job = store.get(ident, oid)
        if job["state"] in ACTIVE:
            raise HTTPException(409, "処理を中止してから削除してください。")
        directory = store.directory(ident).resolve()
        if directory.parent != store.root.resolve() or directory.is_symlink():
            raise ValueError("保存先が不正です。")
        shutil.rmtree(directory, ignore_errors=True)
        store.patch(ident, state="expired", segments=[], message="削除しました。")
    return {"deleted": True}


@app.get("/jobs/{ident}/files/{name}")
def files(ident: str, name: str, oid=Depends(owner)):
    job = store.get(ident, oid)
    if job["state"] == "expired":
        raise KeyError(ident)
    allowed = {"input.mp4", "output.mp4", "preview.mp4", "commentary.wav", audio_diagnostics.LOG_NAME}
    allowed.update(
        f"track-{t['index']}.m4a" for t in job.get("media", {}).get("audio", [])
    )
    allowed.update(
        f"seg-{s['id']}.wav" for s in job["segments"] if s["status"] == "done"
    )
    allowed.update(f"source-{s['id']}.wav" for s in job["segments"])
    allowed.update(
        frame
        for pose in job.get("avatar", {}).get("poses", [])
        for frame in pose.get("frames", [])
    )
    if name not in allowed or (
        name in {"output.mp4", "preview.mp4", "commentary.wav"}
        and job["state"] != "completed"
    ):
        raise KeyError(name)
    path = store.directory(ident) / name
    if name.startswith("source-"):
        # Recovery can correct a row's bounds without an editor save. Include
        # its revision so a previously played excerpt cannot remain stale.
        with store.lock:
            job = store.get(ident, oid)
            seg = next(s for s in job["segments"] if name == f"source-{s['id']}.wav")
            path = store.directory(ident) / f"source-{seg['id']}-r{seg['revision']}.wav"
            if not path.exists():
                media.excerpt(
                    store.directory(ident) / "commentary-source.wav",
                    path,
                    seg["start"],
                    seg["end"],
                )
    if not path.is_file():
        raise KeyError(name)
    if name == audio_diagnostics.LOG_NAME:
        # Snapshot append-only logs so concurrent writes cannot change Content-Length mid-download.
        content = path.read_bytes()
        content = content[:content.rfind(b"\n") + 1]
        return Response(content, media_type="application/x-ndjson", headers={
            "Content-Disposition": f'attachment; filename="{audio_diagnostics.LOG_NAME}"',
            "Cache-Control": "private, no-store",
        })
    filename = "converted.mp4" if name == "output.mp4" else name
    return FileResponse(
        path,
        filename=filename,
        content_disposition_type="inline",
        headers={"Cache-Control": "private, no-store"},
    )
