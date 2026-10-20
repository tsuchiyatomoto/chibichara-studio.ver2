"""R2-backed Voice/ToonOut jobs. Local APIs and all children live inside one job."""
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from movie_worker.serverless import s3_client, read_json, download, has_cancel_request

KEY = re.compile(r"movie-temp/services/(anon_[a-f0-9]{32})/(speech|training|image)/((?:job_|spi_)[a-f0-9]{32})/manifest\.json")
TERMINAL = {"completed", "failed", "cancelled"}


class Cancelled(Exception):
    pass


def write_json(client, bucket, key, value):
    client.put_object(Bucket=bucket, Key=key, Body=json.dumps(value, ensure_ascii=False).encode(), ContentType="application/json")


class LocalService:
    """A process group prevents a training subprocess from surviving its Runpod job."""
    def __init__(self, kind, root, check, progress):
        import httpx
        voice = kind != "image"
        interpreter = "/opt/venvs/" + ("irodori" if voice else "toonout") + "/bin/python"
        command = [interpreter, "-m", "irodori_openai_tts", "--host", "127.0.0.1", "--port", "8088"] if voice else [
            interpreter, "-m", "uvicorn", "toonout_worker.server:app", "--host", "127.0.0.1", "--port", "8091", "--workers", "1"]
        env = os.environ.copy()
        for key, suffix in {
            "IRODORI_VOICES_DIR": "voices", "IRODORI_VOICE_ASSETS_DIR": "assets",
            "IRODORI_SPEAKER_INVERSION_JOBS_DIR": "training", "IRODORI_SPEECH_JOBS_DIR": "speech",
            "TOONOUT_DATA_DIR": "toonout",
        }.items():
            env[key] = str(root / suffix)
        token = env["IRODORI_API_KEY" if voice else "TOONOUT_WORKER_TOKEN"]
        self.http = httpx.Client(base_url="http://127.0.0.1:" + ("8088" if voice else "8091"),
                                 headers={"Authorization": "Bearer " + token}, trust_env=False, timeout=30)
        self.command, self.env = command, env
        self.check, self.progress = check, progress
        self.process = None
        self.active_path = None

    def __enter__(self):
        self.process = subprocess.Popen(self.command, env=self.env, start_new_session=True)
        try:
            deadline = time.monotonic() + 1800
            while time.monotonic() < deadline:
                self.check()
                if self.process.poll() is not None:
                    raise RuntimeError("Local service stopped during initialization")
                try:
                    response = self.http.get("/health", timeout=3)
                    if response.status_code == 200 and response.json().get("status") == "ok":
                        return self
                except Exception:
                    pass
                self.progress({"status": "running", "phase": "loading", "message": "処理サーバーを準備しています。"})
                time.sleep(2)
            raise TimeoutError("Local service did not become ready")
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        if self.process is not None:
            # Signal the entire group, including train.py/latent preparation.
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                pass
            finally:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.process.wait()
        self.http.close()

    def request(self, method, path, **kwargs):
        response = self.http.request(method, path, **kwargs)
        if not response.is_success:
            # Do not publish upstream exception bodies, local paths, or credential URLs.
            raise RuntimeError("Local API rejected the request: HTTP " + str(response.status_code))
        return response

    def run(self, manifest, files):
        owner, kind, payload = manifest["owner"], manifest["kind"], manifest["payload"]
        self.http.headers["X-Irodori-Owner-ID" if kind != "image" else "X-Job-Owner"] = owner
        self.http.headers["Idempotency-Key"] = manifest["id"]
        self.check()
        if kind == "training":
            if not 5 <= len(files) <= 20 or not isinstance(payload.get("voice_id"), str):
                raise ValueError("Invalid training request")
            response = self.request("POST", "/v1/audio/speaker-inversions",
                data={"voice_id": payload["voice_id"], "texts": json.dumps(payload["texts"]), "captions": json.dumps(payload["captions"])},
                files=[("files", (item["name"], path.read_bytes(), "audio/wav")) for item, path in files], timeout=120)
            path_base = "/v1/audio/speaker-inversions/"
            result_suffix, filename, content_type = "/result", "result.speaker.safetensors", "application/octet-stream"
        elif kind == "speech":
            text = payload.get("input")
            if not isinstance(text, str) or not 1 <= len(text) <= 4096 or len(files) > 1:
                raise ValueError("Invalid speech request")
            body = {"model": "irodori-tts", "input": text, "voice": "none", "response_format": "wav",
                    "speed": payload.get("speed", 1), "irodori": {"caption": payload.get("caption", "")}}
            if files:
                item, path = files[0]
                speaker = payload.get("asset_kind") == "speaker_embedding"
                if payload.get("asset_kind") not in {"speaker_embedding", "reference_audio"}:
                    raise ValueError("Invalid voice asset type")
                asset = self.request("POST", "/v1/audio/speaker-assets" if speaker else "/v1/audio/voice-assets/references",
                    data={"name": "saved-voice"} if speaker else {},
                    files={"file": ("voice.speaker.safetensors" if speaker else "reference.wav", path.read_bytes(), "application/octet-stream")}).json()
                body["voice_asset_id"] = asset["id"]
            response = self.request("POST", "/v1/audio/speech-jobs", json=body)
            path_base = "/v1/audio/speech-jobs/"
            result_suffix, filename, content_type = "/content", "result.wav", "audio/wav"
        else:
            if len(files) != 1 or files[0][0]["type"] not in {"image/png", "image/jpeg", "image/webp"}:
                raise ValueError("Invalid image input")
            item, path = files[0]
            response = self.request("POST", "/jobs", content=path.read_bytes(), headers={"Content-Type": item["type"]})
            path_base = "/jobs/"
            result_suffix, filename, content_type = "/content", "result.png", "image/png"
        job = response.json()
        pattern = r"spi_[a-f0-9]{32}" if kind == "training" else r"job_[a-f0-9]{32}"
        if not re.fullmatch(pattern, job.get("id", "")):
            raise ValueError("Invalid local job id")
        self.active_path = path_base + job["id"]
        deadline = time.monotonic() + (7100 if kind == "training" else 1700)
        while job["status"] not in TERMINAL:
            self.check()
            if self.process.poll() is not None:
                raise RuntimeError("Local service stopped")
            if time.monotonic() >= deadline:
                raise TimeoutError("Local processing time limit exceeded")
            self.progress(job)
            time.sleep(2)
            job = self.request("GET", self.active_path).json()
        self.check()
        if job["status"] == "cancelled":
            raise Cancelled()
        if job["status"] != "completed":
            raise RuntimeError("Local job failed")
        response = self.request("GET", self.active_path + result_suffix)
        content = response.content
        if not content or len(content) > (64 * 1024**2 if kind == "speech" else 16 * 1024**2):
            raise ValueError("Invalid result size")
        if kind == "image" and not content.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Invalid image result")
        if kind == "speech" and not (content.startswith(b"RIFF") and content[8:12] == b"WAVE"):
            raise ValueError("Invalid audio result")
        if kind == "training":
            # Verify the actual embedding before publishing or offering Save.
            from safetensors import safe_open
            import torch
            target = files[0][1].parent / "speaker-result.safetensors"
            target.write_bytes(content)
            with safe_open(target, framework="pt") as handle:
                tensor = handle.get_tensor("speaker_embedding")
                if tensor.shape != (16, 768) or not torch.isfinite(tensor).all():
                    raise ValueError("Invalid speaker embedding")
        return content, filename, content_type, job


def run_service_job(payload, *, client=None, service_factory=LocalService, scratch=None, role=None):
    key = payload.get("input", {}).get("manifest_key", "")
    match = KEY.fullmatch(key)
    if not match:
        raise ValueError("Invalid service manifest key")
    owner, kind, ident = match.groups()
    if not ident.startswith("spi_" if kind == "training" else "job_"):
        raise ValueError("Invalid public job id")
    role = role or os.environ.get("SERVERLESS_ROLE")
    if role not in {"voice", "toonout"} or (kind == "image") != (role == "toonout"):
        raise ValueError("Task does not match this endpoint")
    bucket = os.environ["MOVIE_S3_BUCKET"]
    client = client or s3_client()
    prefix = key[:-len("manifest.json")]
    manifest = read_json(client, bucket, key)
    if manifest.get("version") != 1 or manifest["owner"] != owner or manifest["kind"] != kind or manifest["id"] != ident:
        raise ValueError("Invalid manifest")
    job = dict(manifest["job"])
    if job["id"] != ident:
        raise ValueError("Invalid public job")
    # A retry/duplicate delivery may reuse a completed R2 result without GPU work.
    try:
        result = read_json(client, bucket, prefix + "result.json")
        if result.get("status") in TERMINAL:
            return {"id": ident, "status": result["status"]}
    except Exception as error:
        if getattr(error, "response", {}).get("Error", {}).get("Code") not in {"NoSuchKey", "404"}:
            raise
    if payload.get("id"):
        try:
            client.put_object(Bucket=bucket, Key=prefix + "worker.json", Body=json.dumps({"runId": payload["id"]}).encode(),
                              ContentType="application/json", IfNoneMatch="*")
        except Exception as error:
            if getattr(error, "response", {}).get("Error", {}).get("Code") in {"PreconditionFailed", "ConditionalRequestConflict", "412", "409"}:
                return {"id": ident, "status": "duplicate"}
            raise
        write_json(client, bucket, prefix + "receipt.json", {"runId": payload["id"]})

    def check():
        if manifest["expires"] <= time.time() or has_cancel_request(client, bucket, prefix):
            raise Cancelled()

    def progress(update):
        # Only safe, public fields pass through; local ids/paths never leave the worker.
        for name in ("status", "phase", "progress", "sample_count"):
            if name in update:
                job[name] = update[name]
        job["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        job["message"] = "声を学習しています。" if kind == "training" and job.get("phase") != "loading" else "処理しています。"
        write_json(client, bucket, prefix + "progress.json", job)

    try:
        check()
        root = Path(scratch or "/tmp/chibichara-services").resolve()
        if root == Path("/runpod-volume") or Path("/runpod-volume") in root.parents:
            raise ValueError("Scratch must be local")
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        inputs = manifest["files"]
        if not isinstance(inputs, list) or len(inputs) > 20:
            raise ValueError("Invalid files")
        with tempfile.TemporaryDirectory(prefix=ident + "-", dir=root) as temporary:
            directory = Path(temporary)
            staged = []
            total = 0
            for index, item in enumerate(inputs):
                check()
                if item["key"] != prefix + "inputs/" + str(index) + "-" + item["sha256"] or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]):
                    raise ValueError("Input escaped its job scope")
                path = directory / ("input-" + str(index))
                size = download(client, bucket, item["key"], path, 25 * 1024**2 if kind == "training" else 12 * 1024**2)
                total += size
                if size != item["bytes"] or total > 100 * 1024**2 or hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
                    raise ValueError("Invalid input integrity")
                staged.append((item, path))
            progress({"status": "running", "phase": "loading"})
            with service_factory(kind, directory, check, progress) as service:
                content, filename, content_type, local_job = service.run(manifest, staged)
                check()
                client.put_object(Bucket=bucket, Key=prefix + filename, Body=content, ContentType=content_type)
                check()
                job.update(status="completed", error=None)
                if kind == "training":
                    job.update(phase="completed", progress=local_job["progress"], result={
                        "filename": filename, "voice_id": manifest["payload"]["voice_id"], "saved": False, "registered": False,
                        "saved_asset_id": None, "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(manifest["expires"]))})
            # Child group is gone and local scratch cleaned before terminal publication.
    except Cancelled:
        job.update(status="cancelled", error=None, result=None)
    except Exception as error:
        print("Service job failed: " + type(error).__name__, file=sys.stderr, flush=True)
        job.update(status="failed", error="処理に失敗しました。時間をおいて再生成してください。", result=None)
    job["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write_json(client, bucket, prefix + "result.json", job)
    return {"id": ident, "status": job["status"]}


def main():
    import runpod
    runpod.serverless.start({"handler": run_service_job})


if __name__ == "__main__":
    main()
