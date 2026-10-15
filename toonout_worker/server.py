import os
import secrets
from contextlib import asynccontextmanager

import anyio
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from . import config
from .model import ToonOut

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


@asynccontextmanager
async def lifespan(_app):
    global processor
    processor = await anyio.to_thread.run_sync(ToonOut)
    try:
        yield
    finally:
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
    if processor is None:
        raise HTTPException(503, "ToonOut is loading.")
    return {
        "status": "ok",
        "model": config.MODEL_REPO,
        "model_revision": config.MODEL_REVISION,
        "base_revision": config.BASE_REVISION,
        "device": processor.device,
        "inference_size": config.INFERENCE_SIZE,
    }


@app.post("/remove-background")
async def remove_background(request: Request):
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
    result = await anyio.to_thread.run_sync(processor.remove, bytes(content))
    return Response(
        result,
        media_type="image/png",
        headers={
            "Cache-Control": "private, no-store",
            "X-ToonOut-Model": config.MODEL_REPO,
            "X-ToonOut-Device": processor.device,
        },
    )
