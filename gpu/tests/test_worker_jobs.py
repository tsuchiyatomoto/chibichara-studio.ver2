import asyncio
import time

import pytest

from worker_jobs import JobConflict, JobNotFound, PersistentJobs, QueueFull

OWNER = "anon_" + "a" * 32
OTHER = "anon_" + "b" * 32
KEY = "request_" + "a" * 24


async def eventually(predicate):
    for _ in range(200):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Job did not reach the expected state")


def test_slow_job_accepts_immediately_and_retry_does_not_duplicate(tmp_path):
    async def scenario():
        release = asyncio.Event()
        calls = []

        async def process(record, directory):
            calls.append(record["id"])
            await release.wait()
            return (directory / "input").read_bytes(), "audio/wav"

        jobs = PersistentJobs(tmp_path, process)
        await jobs.start()
        try:
            started = time.monotonic()
            job = jobs.submit(OWNER, KEY, {"input": "private text"}, data=b"wav")
            assert time.monotonic() - started < 1
            assert jobs.submit(OWNER, KEY, {"input": "private text"}, data=b"wav")["id"] == job["id"]
            assert "payload" not in job and "owner" not in job and "key" not in job
            await eventually(lambda: bool(calls))
            assert jobs.get(job["id"], OWNER)["status"] == "running"
            with pytest.raises(JobConflict):
                jobs.result(job["id"], OWNER)
            release.set()
            await eventually(lambda: jobs.get(job["id"], OWNER)["status"] == "completed")
            path, mime = jobs.result(job["id"], OWNER)
            assert path.read_bytes() == b"wav" and mime == "audio/wav"
            assert len(calls) == 1
        finally:
            release.set()
            await jobs.stop()
    asyncio.run(scenario())


def test_owner_boundaries_and_idempotency_conflicts(tmp_path):
    async def scenario():
        jobs = PersistentJobs(tmp_path, lambda *_: None)
        await jobs.start()
        job = jobs.submit(OWNER, KEY, {"input": "one"})
        with pytest.raises(JobConflict):
            jobs.submit(OWNER, KEY, {"input": "two"})
        for action in (jobs.get, jobs.cancel, jobs.result):
            with pytest.raises(JobNotFound):
                action(job["id"], OTHER)
            with pytest.raises(JobNotFound):
                action("../state.json", OWNER)
        with pytest.raises(ValueError):
            jobs.submit(OWNER, "short", {})
        await jobs.stop()
    asyncio.run(scenario())


def test_cancellation_keeps_inflight_gpu_work_owned_until_it_finishes(tmp_path):
    async def scenario():
        release = asyncio.Event()
        calls = []

        async def process(record, _directory):
            calls.append(record["id"])
            await release.wait()
            return b"discarded", "image/png"

        jobs = PersistentJobs(tmp_path, process)
        await jobs.start()
        first = jobs.submit(OWNER, KEY, {})
        queued = jobs.submit(OWNER, KEY + "2", {})
        await eventually(lambda: len(calls) == 1)
        assert jobs.cancel(first["id"], OWNER)["status"] == "cancelling"
        assert jobs.cancel(queued["id"], OWNER)["status"] == "cancelled"
        await asyncio.sleep(0.02)
        assert len(calls) == 1
        release.set()
        await eventually(lambda: jobs.get(first["id"], OWNER)["status"] == "cancelled")
        with pytest.raises(JobConflict):
            jobs.result(first["id"], OWNER)
        await jobs.stop()
    asyncio.run(scenario())


def test_restart_recovers_queue_but_does_not_repeat_interrupted_generation(tmp_path):
    async def scenario():
        calls = []

        async def process(record, _directory):
            calls.append(record["id"])
            return b"persisted", "audio/wav"

        first = PersistentJobs(tmp_path, process)
        await first.start()
        interrupted = first.submit(OWNER, KEY, {})
        queued = first.submit(OWNER, KEY + "2", {})
        first.records[interrupted["id"]]["status"] = "running"
        first._save(first.records[interrupted["id"]])
        await first.stop()
        restored = PersistentJobs(tmp_path, process)
        await restored.start()
        assert restored.get(interrupted["id"], OWNER)["status"] == "failed"
        await eventually(lambda: restored.get(queued["id"], OWNER)["status"] == "completed")
        assert calls == [queued["id"]]
        await restored.stop()
        third = PersistentJobs(tmp_path, process)
        await third.start()
        assert third.result(queued["id"], OWNER)[0].read_bytes() == b"persisted"
        await third.stop()
    asyncio.run(scenario())


def test_queue_limits_and_terminal_expiry(tmp_path):
    async def scenario():
        jobs = PersistentJobs(tmp_path, lambda *_: None, max_per_owner=1)
        await jobs.start()
        job = jobs.submit(OWNER, KEY, {}, data=b"private image")
        with pytest.raises(QueueFull):
            jobs.submit(OWNER, KEY + "2", {})
        jobs.cancel(job["id"], OWNER)
        jobs.records[job["id"]]["updated_at"] = time.time() - 90000
        jobs.cleanup()
        with pytest.raises(JobNotFound):
            jobs.get(job["id"], OWNER)
        assert not jobs.directory(job["id"]).exists()
        await jobs.stop()
    asyncio.run(scenario())


def test_locked_expired_download_does_not_stop_other_jobs(tmp_path, monkeypatch):
    async def scenario():
        async def process(*_args):
            return b"new-result", "audio/wav"

        jobs = PersistentJobs(tmp_path, process)
        await jobs.start()
        old = jobs.submit(OWNER, KEY, {})
        jobs.cancel(old["id"], OWNER)
        jobs.records[old["id"]]["updated_at"] = time.time() - 90000

        def locked(_ident):
            raise PermissionError("Download still has the result open")

        monkeypatch.setattr(jobs, "_remove_directory", locked)
        jobs.cleanup()
        current = jobs.submit(OWNER, KEY + "2", {})
        await eventually(lambda: jobs.get(current["id"], OWNER)["status"] == "completed")
        assert jobs.ready
        await jobs.stop()
    asyncio.run(scenario())
