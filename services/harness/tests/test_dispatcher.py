import time

import pytest

from harness import store
from harness.config import Config
from harness.dispatcher import Dispatcher


@pytest.fixture
def cfg(tmp_path):
    return Config(db_path=str(tmp_path / "t.db"), max_workers=4, heartbeat_s=0.2, lease_s=1.0, retry_backoff_s=0)


def run_until_idle(d: Dispatcher, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        d.tick()
        active = d.db.execute("select count(*) from jobs where status in ('queued','running')").fetchone()[0]
        if not active and not d.running:
            return
        time.sleep(0.05)
    raise AssertionError("dispatcher did not go idle")


def test_echo_succeeds(cfg):
    d = Dispatcher(cfg, "t1")
    job, _ = store.submit(d.db, kind="echo", payload={"x": 1})
    run_until_idle(d)
    job = store.get(d.db, job["id"])
    assert job["status"] == "succeeded"
    assert job["result"] == {"echo": {"x": 1}, "attempt": 1}


def test_crash_is_isolated_retried_and_resumes_from_checkpoint(cfg):
    d = Dispatcher(cfg, "t1")
    crashy, _ = store.submit(d.db, kind="sleep", payload={"seconds": 3, "crash_at": 2})
    sibling, _ = store.submit(d.db, kind="sleep", payload={"seconds": 2})
    run_until_idle(d)
    crashy, sibling = store.get(d.db, crashy["id"]), store.get(d.db, sibling["id"])
    # One child dying must not take down its sibling (a ProcessPoolExecutor would).
    assert sibling["status"] == "succeeded" and sibling["attempts"] == 1
    assert crashy["status"] == "succeeded" and crashy["attempts"] == 2
    assert crashy["result"]["resumed_from"] == 2


def test_permanent_error_is_not_retried(cfg):
    d = Dispatcher(cfg, "t1")
    job, _ = store.submit(d.db, kind="fail", payload={"permanent": True}, max_attempts=3)
    run_until_idle(d)
    job = store.get(d.db, job["id"])
    assert job["status"] == "failed" and job["attempts"] == 1


def test_transient_error_exhausts_attempts(cfg):
    d = Dispatcher(cfg, "t1")
    job, _ = store.submit(d.db, kind="fail", payload={}, max_attempts=2)
    run_until_idle(d)
    job = store.get(d.db, job["id"])
    assert job["status"] == "failed" and job["attempts"] == 2
    assert "RuntimeError" in job["error"]


def test_timeout_kills_the_process(cfg):
    d = Dispatcher(cfg, "t1")
    job, _ = store.submit(d.db, kind="sleep", payload={"seconds": 30}, timeout_s=1.5, max_attempts=1)
    started = time.time()
    run_until_idle(d)
    job = store.get(d.db, job["id"])
    assert job["status"] == "failed" and "timed out" in job["error"]
    assert time.time() - started < 10


def test_cancel_running_job(cfg):
    d = Dispatcher(cfg, "t1")
    job, _ = store.submit(d.db, kind="sleep", payload={"seconds": 30})
    while job["id"] not in d.running:
        d.tick()
    store.request_cancel(d.db, job["id"])
    run_until_idle(d)
    assert store.get(d.db, job["id"])["status"] == "cancelled"


def test_key_dedupes_only_while_active(cfg):
    d = Dispatcher(cfg, "t1")
    a, created_a = store.submit(d.db, kind="echo", payload={}, key="brand-1")
    b, created_b = store.submit(d.db, kind="echo", payload={}, key="brand-1")
    assert created_a and not created_b and a["id"] == b["id"]
    run_until_idle(d)
    c, created_c = store.submit(d.db, kind="echo", payload={}, key="brand-1")
    assert created_c and c["id"] != a["id"]


def test_orphaned_job_is_recovered_by_another_dispatcher(cfg):
    dead = Dispatcher(cfg, "dead")
    job, _ = store.submit(dead.db, kind="echo", payload={})
    store.claim(dead.db, "dead", 1)  # claimed, then the dispatcher "dies"
    alive = Dispatcher(cfg, "alive")
    time.sleep(cfg.lease_s + 0.1)
    run_until_idle(alive)
    job = store.get(alive.db, job["id"])
    assert job["status"] == "succeeded" and job["attempts"] == 2
    # A late result from the dead owner must not overwrite the new run.
    assert not store.finish(alive.db, job["id"], "dead", "failed", error="late")


def test_graceful_stop_releases_without_charging_an_attempt(cfg):
    cfg = Config(**{**cfg.__dict__, "shutdown_grace_s": 0.3})
    d = Dispatcher(cfg, "t1")
    job, _ = store.submit(d.db, kind="sleep", payload={"seconds": 30})
    while job["id"] not in d.running:
        d.tick()
    d.stop()
    while not d.tick():
        time.sleep(0.05)
    job = store.get(d.db, job["id"])
    assert job["status"] == "queued" and job["attempts"] == 0
