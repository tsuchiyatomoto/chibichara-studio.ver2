"""Durable, owner-scoped jobs for a single worker process and local filesystem."""

import asyncio
import copy
import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)
ACTIVE = {"queued", "running", "cancelling"}


class JobNotFound(Exception):
    pass


class JobConflict(Exception):
    pass


class QueueFull(Exception):
    pass


class PersistentJobs:
    def __init__(self, root, process, *, ttl=86400, max_pending=64, max_per_owner=8):
        self.root = Path(root).resolve()
        self.process = process
        self.ttl = ttl
        self.max_pending = max_pending
        self.max_per_owner = max_per_owner
        self.records = {}
        self.lock = threading.RLock()
        self.task = None
        self.stopping = False

    @property
    def ready(self):
        return self.task is not None and not self.task.done() and not self.stopping

    async def start(self):
        if self.task is not None:
            return
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.lock:
            self.records = {}
            for state in self.root.glob("job_*/state.json"):
                try:
                    record = json.loads(state.read_text(encoding="utf-8"))
                    if state.parent != self.directory(record["id"]):
                        continue
                    if record["status"] in {"running", "cancelling"}:
                        record.update(status="failed", error="サーバーの再起動で処理が中断されました。再試行してください。", updated_at=time.time())
                        self._save(record)
                    self.records[record["id"]] = record
                except (OSError, ValueError, KeyError, JobNotFound):
                    logger.exception("Could not restore a worker job")
            self.cleanup()
        self.stopping = False
        self.task = asyncio.create_task(self._work())

    async def stop(self):
        # Do not cancel a running GPU future: its lock must remain held until it returns.
        self.stopping = True
        if self.task is not None:
            await self.task
            self.task = None

    def directory(self, ident):
        if not re.fullmatch(r"job_[a-f0-9]{32}", ident):
            raise JobNotFound
        return self.root / ident

    def _save(self, record):
        path = self.directory(record["id"])
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = path / "state.json.tmp"
        temporary.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, path / "state.json")

    def cleanup(self):
        with self.lock:
            expired = [ident for ident, record in self.records.items()
                       if record["status"] not in ACTIVE and record["updated_at"] + self.ttl < time.time()]
            for ident in expired:
                try:
                    self._remove_directory(ident)
                except OSError:
                    logger.warning("Job expiry cleanup will retry: %s", ident)
                    continue
                del self.records[ident]

    def _remove_directory(self, ident):
        path = self.directory(ident)
        if path.resolve().parent != self.root:
            raise ValueError("Job directory is outside its data root.")
        shutil.rmtree(path)

    def submit(self, owner, key, payload, *, data=None, prepare=None):
        if not self.ready:
            raise QueueFull("Worker is not ready.")
        if not re.fullmatch(r"anon_[a-f0-9]{32}", owner):
            raise ValueError("Invalid job owner.")
        if not re.fullmatch(r"[a-zA-Z0-9_-]{16,128}", key):
            raise ValueError("A 16-128 character Idempotency-Key is required.")
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode())
        if data is not None:
            digest.update(data)
        fingerprint = digest.hexdigest()
        with self.lock:
            self.cleanup()
            for record in self.records.values():
                if record["owner"] == owner and record["key"] == key:
                    if record["fingerprint"] != fingerprint:
                        raise JobConflict("This request key was already used for different input.")
                    return self.public(record)
            pending = [r for r in self.records.values() if r["status"] in ACTIVE]
            if len(pending) >= self.max_pending or sum(r["owner"] == owner for r in pending) >= self.max_per_owner:
                raise QueueFull("処理待ちが多いため、しばらくしてから再試行してください。")
            now = time.time()
            record = {"id": "job_" + uuid.uuid4().hex, "owner": owner, "key": key,
                      "fingerprint": fingerprint, "payload": copy.deepcopy(payload),
                      "status": "queued", "error": None, "created_at": now, "updated_at": now}
            directory = self.directory(record["id"])
            directory.mkdir(mode=0o700)
            try:
                if data is not None:
                    (directory / "input").write_bytes(data)
                if prepare is not None:
                    prepare(directory, record["payload"])
                self._save(record)
            except BaseException:
                self._remove_directory(record["id"])
                raise
            self.records[record["id"]] = record
            return self.public(record)

    @staticmethod
    def public(record):
        return {key: record[key] for key in ("id", "status", "error", "created_at", "updated_at")}

    def _owned(self, ident, owner):
        self.directory(ident)
        record = self.records.get(ident)
        if record is None or record["owner"] != owner or (
            record["status"] not in ACTIVE and record["updated_at"] + self.ttl < time.time()
        ):
            raise JobNotFound
        return record

    def get(self, ident, owner):
        with self.lock:
            return self.public(self._owned(ident, owner))

    def cancel(self, ident, owner):
        with self.lock:
            record = self._owned(ident, owner)
            if record["status"] in ACTIVE:
                record.update(status="cancelled" if record["status"] == "queued" else "cancelling", updated_at=time.time())
                self._save(record)
            return self.public(record)

    def result(self, ident, owner):
        with self.lock:
            record = self._owned(ident, owner)
            if record["status"] != "completed":
                raise JobConflict("処理はまだ完了していません。")
            return self.directory(ident) / "result", record["content_type"]

    async def _work(self):
        while not self.stopping:
            with self.lock:
                self.cleanup()
                record = min((r for r in self.records.values() if r["status"] == "queued"),
                             key=lambda r: r["created_at"], default=None)
                if record is not None:
                    record.update(status="running", updated_at=time.time())
                    self._save(record)
            if record is None:
                await asyncio.sleep(0.2)
                continue
            try:
                content, content_type = await self.process(record, self.directory(record["id"]))
                if not content:
                    raise ValueError("生成結果が空でした。")
                with self.lock:
                    if record["status"] == "cancelling":
                        record.update(status="cancelled")
                    else:
                        path = self.directory(record["id"])
                        temporary = path / "result.tmp"
                        temporary.write_bytes(content)
                        os.replace(temporary, path / "result")
                        record.update(status="completed", content_type=content_type)
            except Exception:
                logger.exception("Worker job failed: %s", record["id"])
                with self.lock:
                    record.update(status="cancelled" if record["status"] == "cancelling" else "failed",
                                  error="処理に失敗しました。設定を確認して再試行してください。")
            finally:
                with self.lock:
                    record["updated_at"] = time.time()
                    self._save(record)
                    # Inputs/snapshots need only survive while their job is active.
                    for path in self.directory(record["id"]).iterdir():
                        if path.name not in {"state.json", "result"} and path.is_file():
                            try:
                                path.unlink(missing_ok=True)
                            except OSError:
                                logger.warning("Keeping locked job input until expiry: %s", record["id"])
