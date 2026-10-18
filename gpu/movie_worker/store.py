import json
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager

from . import config

ACTIVE = {"queued", "validating", "analyzing", "synthesizing", "mixing", "cancelling"}


class Store:
    def __init__(self, root=config.DATA):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute(
                "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, updated REAL NOT NULL, body TEXT NOT NULL)"
            )

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.root / "jobs.sqlite3", timeout=30)
        try:
            with db:
                yield db
        finally:
            db.close()

    def directory(self, ident):
        if not re.fullmatch(r"[a-f0-9]{32}", ident):
            raise KeyError("ジョブが見つかりません。")
        return self.root / ident

    @contextmanager
    def edit(self, ident, owner=None):
        self.directory(ident)
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT owner, body FROM jobs WHERE id=?", (ident,)
            ).fetchone()
            if not row or (owner is not None and row[0] != owner):
                raise KeyError("ジョブが見つかりません。")
            job = json.loads(row[1])
            yield job
            job["updated"] = time.time()
            db.execute(
                "UPDATE jobs SET updated=?, body=? WHERE id=?",
                (job["updated"], json.dumps(job, ensure_ascii=False), ident),
            )

    def get(self, ident, owner=None):
        self.directory(ident)
        with self.lock, self.connect() as db:
            row = db.execute(
                "SELECT owner,body FROM jobs WHERE id=?", (ident,)
            ).fetchone()
        if not row or (owner is not None and row[0] != owner):
            raise KeyError("ジョブが見つかりません。")
        return json.loads(row[1])

    def list(self, owner=None):
        with self.lock, self.connect() as db:
            rows = db.execute(
                "SELECT body FROM jobs WHERE (? IS NULL OR owner=?) ORDER BY updated DESC",
                (owner, owner),
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def create(self, owner, name, size):
        ident = uuid.uuid4().hex
        now = time.time()
        job = dict(
            id=ident,
            owner=owner,
            name=name,
            size=size,
            received=0,
            state="uploading",
            task=None,
            created=now,
            updated=now,
            message="MP4をアップロードしてください。",
            segments=[],
            progress=0,
            error=None,
            confirmed=False,
            game_gain=1.0,
            voice_gain=1.0,
        )
        self.directory(ident).mkdir()
        with self.lock, self.connect() as db:
            db.execute(
                "INSERT INTO jobs VALUES (?,?,?,?)",
                (ident, owner, now, json.dumps(job, ensure_ascii=False)),
            )
        return job

    def patch(self, ident, **changes):
        with self.edit(ident) as job:
            job.update(changes)

    def public(self, job):
        return {
            k: v
            for k, v in job.items()
            if k not in {"owner", "snapshot_path", "tts_fingerprint", "upload_chunks"}
        }
