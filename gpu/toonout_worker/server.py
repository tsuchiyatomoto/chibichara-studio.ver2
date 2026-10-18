import os
import re
import secrets
from contextlib import asynccontextmanager

import anyio
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from . import config
from .model import ToonOut
from worker_jobs import JobConflict, JobNotFound, PersistentJobs, QueueFull

token_file = config.DATA / "service.token"
if not token_file.exists():
    try:
        with token_file.open("x", encoding="utf-8") as file:
            file.write(secrets.token_urlsafe(48))
        os.chmod(token_file, 0o600)
    except FileExistsError:
        pass
TOKEN = config.TOKEN or token_file.read_text(encoding="utf-8").strip()
processor = None
jobs = None


@asynccontextmanager
async def lifespan(_app):
    global processor, jobs
    processor = await anyio.to_thread.run_sync(ToonOut)
    jobs = PersistentJobs(config.DATA / "jobs", process_job)
    await jobs.start()
    try:
        yield
    finally:
        await jobs.stop()
        processor = None
        if __import__("torch").cuda.is_available():
            __import__("torch").cuda.empty_cache()


def authorize(authorization: str = Header("")):
    if not secrets.compare_digest(authorization, "Bearer " + TOKEN):
        raise HTTPException(401, "Authentication required.")


app = FastAPI(
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    dependencies=[Depends(authorize)],
)


@app.exception_handler(ValueError)
async def invalid(_request, exc):
    return JSONResponse({"error": str(exc)}, status_code=400)


@app.get("/health")
def health():
    if processor is None or jobs is None or not jobs.ready:
        raise HTTPException(503, "ToonOut is loading.")
    return {
        "status": "ok",
        "model": config.MODEL_REPO,
        "model_revision": config.MODEL_REVISION,
        "base_revision": config.BASE_REVISION,
        "device": processor.device,
        "inference_size": config.INFERENCE_SIZE,
        "jobs": True,
    }


async def read_image(request: Request):
    if processor is None:
        raise HTTPException(503, "ToonOut is loading.")
    content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
    if content_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise HTTPException(415, "Send a PNG, JPEG, or WebP image.")
    length = request.headers.get("content-length")
    if length and int(length) > config.MAX_BYTES:
        raise HTTPException(413, "Image is too large.")
    content = bytearray()
    async for chunk in request.stream():
        if len(content) + len(chunk) > config.MAX_BYTES:
            raise HTTPException(413, "Image is too large.")
        content.extend(chunk)
    if not content:
        raise HTTPException(400, "Image is empty.")
    return bytes(content)


async def process_job(_record, directory):
    content = await anyio.to_thread.run_sync(processor.remove, (directory / "input").read_bytes())
    return content, "image/png"


def job_owner(value: str = Header("", alias="X-Job-Owner")):
    if not re.fullmatch(r"anon_[a-f0-9]{32}", value):
        raise HTTPException(400, "Invalid job owner.")
    return value


@app.post("/jobs", status_code=202)
async def create_job(
    request: Request, owner: str = Depends(job_owner),
    key: str = Header("", alias="Idempotency-Key"),
):
    data = await read_image(request)
    try:
        return jobs.submit(owner, key, {"content_type": request.headers.get("content-type")}, data=data)
    except JobConflict as error:
        raise HTTPException(409, str(error)) from error
    except QueueFull as error:
        raise HTTPException(429, str(error)) from error


@app.get("/jobs/{job_id}")
def get_job(job_id: str, owner: str = Depends(job_owner)):
    try:
        return jobs.get(job_id, owner)
    except JobNotFound:
        raise HTTPException(404, "Job was not found.") from None


@app.delete("/jobs/{job_id}")
def cancel_job(job_id: str, owner: str = Depends(job_owner)):
    try:
        return jobs.cancel(job_id, owner)
    except JobNotFound:
        raise HTTPException(404, "Job was not found.") from None


@app.get("/jobs/{job_id}/content")
def job_content(job_id: str, owner: str = Depends(job_owner)):
    try:
        path, content_type = jobs.result(job_id, owner)
        return FileResponse(path, media_type=content_type, filename="transparent.png", headers={"Cache-Control": "private, no-store"})
    except JobNotFound:
        raise HTTPException(404, "Job was not found.") from None
    except JobConflict as error:
        raise HTTPException(409, str(error)) from error


@app.post("/remove-background")
async def remove_background(request: Request):
    # Retained for trusted Pod-local callers. Web requests use /jobs.
    result = await anyio.to_thread.run_sync(processor.remove, await read_image(request))
    return Response(
        result,
        media_type="image/png",
        headers={
            "Cache-Control": "private, no-store",
            "X-ToonOut-Model": config.MODEL_REPO,
            "X-ToonOut-Device": processor.device,
        },
    )
