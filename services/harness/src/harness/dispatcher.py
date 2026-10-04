"""Dispatcher: claims jobs from SQLite and runs each in its own spawned process.

Differences from the amazon server.py model, and why:

* One Process per job instead of a ProcessPoolExecutor. With
  max_tasks_per_child=1 the pool was already process-per-task, but a pool
  can't kill one task (no per-job timeout/cancel), and a single child dying
  marks the *whole* executor broken and fails every in-flight sibling. Owning
  the Process objects gives kill-on-timeout, cancel, and crash isolation, and
  `join()` reaps each child, so no zombies.
* The dispatcher is its own process, not threads inside gunicorn workers. The
  API only reads/writes rows, so N gunicorn workers never multiply the
  concurrency limit (each amazon worker had its own pool of
  max_concurrent_requests), and there's no HTTP-to-self queue hop.
* Single-threaded event loop: no done-callbacks on executor threads, no
  locks around a global pool, no thread-bound sqlite gymnastics.
* Leases + heartbeats instead of startup reset + fixed stuck timeout: safe
  with several dispatchers (one per machine) on the same DB.
"""
import logging
import multiprocessing as mp
import os
import signal
import socket
import time
import traceback
from dataclasses import dataclass
from multiprocessing.connection import Connection
from typing import Any

from . import store, sysmetrics
from .config import Config, load
from .handlers import REGISTRY, Context, Permanent

log = logging.getLogger("harness.dispatcher")
_ctx = mp.get_context("spawn")


def _child_main(job: dict[str, Any], db_path: str, worker: str, conn: Connection) -> None:
    """Entry point of a job process. Sends exactly one (outcome, value) tuple,
    unless the process is killed or the job stops being ours."""
    db = store.connect(db_path)
    ctx = Context(
        job_id=job["id"],
        attempt=job["attempts"],
        resume=job["checkpoint"],
        _save=lambda state: store.save_checkpoint(db, job["id"], worker, state),
        _progress=lambda state: store.save_progress(db, job["id"], worker, state),
    )
    try:
        fn = REGISTRY[job["kind"]]
        conn.send(("ok", fn(job["payload"], ctx)))
    except SystemExit:
        pass  # lease lost — parent's guarded write will be a no-op anyway
    except Permanent as e:
        conn.send(("permanent", str(e)))
    except BaseException as e:
        conn.send(("error", f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=8)}"))
    finally:
        conn.close()
        db.close()


@dataclass
class Running:
    job: dict[str, Any]
    proc: Any  # SpawnProcess
    conn: Connection
    deadline: float
    outcome: tuple[str, Any] | None = None


class Dispatcher:
    def __init__(self, cfg: Config, worker_id: str | None = None):
        self.cfg = cfg
        self.worker = worker_id or f"{socket.gethostname()}:{os.getpid()}"
        self.db = store.connect(cfg.db_path)
        self.running: dict[str, Running] = {}
        self.stopping = False
        self._stop_deadline = 0.0
        self._last_heartbeat = 0.0
        self._last_recover = 0.0
        self._last_sample = 0.0
        self.sample_s = float(os.environ.get("HARNESS_SAMPLE_S", "15"))
        sysmetrics.psutil.cpu_percent(interval=None)  # prime the CPU % baseline

    # ---- lifecycle --------------------------------------------------------

    def stop(self, *_: Any) -> None:
        if not self.stopping:
            log.info("stopping: draining %d running job(s), grace %.0fs", len(self.running), self.cfg.shutdown_grace_s)
            self.stopping = True
            self._stop_deadline = time.time() + self.cfg.shutdown_grace_s

    def run_forever(self) -> None:
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        log.info("dispatcher %s up: max_workers=%d db=%s", self.worker, self.cfg.max_workers, self.cfg.db_path)
        while not self.tick():
            time.sleep(self.cfg.poll_interval_s)
        log.info("dispatcher %s stopped", self.worker)

    def tick(self) -> bool:
        """One loop iteration. Returns True once fully stopped."""
        now = time.time()
        self._collect()
        self._enforce(now)
        if now - self._last_heartbeat >= self.cfg.heartbeat_s:
            store.heartbeat(self.db, self.worker)
            self._last_heartbeat = now
        if now - self._last_recover >= self.cfg.heartbeat_s:
            for r in store.recover_expired(self.db, self.cfg.lease_s, self.cfg.retry_backoff_s):
                log.warning("recovered orphaned job %s -> %s", r["id"], r["status"])
            self._last_recover = now
        if self.sample_s > 0 and now - self._last_sample >= self.sample_s:
            self._sample()
            self._last_sample = now
        if self.stopping:
            if self.running and now >= self._stop_deadline:
                for jid in list(self.running):
                    self._kill(jid)
                    store.release(self.db, jid, self.worker, "released: dispatcher shut down mid-run")
                    log.info("released %s back to queue", jid)
            return not self.running
        self._start(self.cfg.max_workers - len(self.running))
        return False

    # ---- internals --------------------------------------------------------

    def _sample(self) -> None:
        try:
            queued = self.db.execute("select count(*) from jobs where status = 'queued'").fetchone()[0]
            s = sysmetrics.sample(len(self.running), queued)
            store.add_sample(self.db, self.worker, s)
            log.info("capacity: %s", sysmetrics.one_line(s))
        except Exception as e:  # metrics must never take the dispatcher down
            log.warning("capacity sample failed: %s", e)

    def _start(self, free: int) -> None:
        for job in store.claim(self.db, self.worker, free):
            if job["kind"] not in REGISTRY:
                store.finish(self.db, job["id"], self.worker, "failed", error=f"unknown kind {job['kind']!r}")
                continue
            parent, child = _ctx.Pipe(duplex=False)
            proc = _ctx.Process(
                target=_child_main, args=(job, self.cfg.db_path, self.worker, child),
                name=f"job-{job['kind']}-{job['id'][:8]}", daemon=True,
            )
            proc.start()
            child.close()  # parent keeps only the read end, so EOF works
            self.running[job["id"]] = Running(job, proc, parent, time.time() + job["timeout_s"])
            log.info("started %s kind=%s attempt=%d pid=%s", job["id"], job["kind"], job["attempts"], proc.pid)

    def _collect(self) -> None:
        for jid, r in list(self.running.items()):
            # Drain the pipe before checking liveness: a child blocked sending
            # a large result would otherwise never exit.
            if r.outcome is None and r.conn.poll():
                try:
                    r.outcome = r.conn.recv()
                except (EOFError, OSError):
                    pass
            if r.proc.is_alive():
                continue
            r.proc.join()
            r.conn.close()
            del self.running[jid]
            self._settle(r)

    def _settle(self, r: Running) -> None:
        jid = r.job["id"]
        kind, value = r.outcome or ("crash", f"job process exited without a result (exit code {r.proc.exitcode})")
        if kind == "ok":
            if store.finish(self.db, jid, self.worker, "succeeded", result=value):
                perf = ""
                if isinstance(value, dict) and value.get("usage"):
                    u = value["usage"]
                    perf = (f" model={value.get('model')} in={u.get('prompt_tokens')} out={u.get('completion_tokens')}"
                            f" tok/s={value.get('tokens_per_s')} ttft={value.get('ttft_s')}s")
                log.info("succeeded %s in %.2fs%s", jid, time.time() - r.job["started_at"], perf)
            return
        status = store.retry_or_fail(
            self.db, jid, self.worker, value, backoff_s=self.cfg.retry_backoff_s, permanent=kind == "permanent",
        )
        log.warning("%s %s -> %s: %s", kind, jid, status or "not ours anymore", value.splitlines()[0])

    def _enforce(self, now: float) -> None:
        cancels = store.cancel_requested_ids(self.db, self.worker) if self.running else set()
        for jid, r in list(self.running.items()):
            if jid in cancels:
                self._kill(jid)
                store.finish(self.db, jid, self.worker, "cancelled", error="cancelled by request")
                log.info("cancelled %s", jid)
            elif now >= r.deadline:
                self._kill(jid)
                status = store.retry_or_fail(
                    self.db, jid, self.worker, f"timed out after {r.job['timeout_s']:.0f}s",
                    backoff_s=self.cfg.retry_backoff_s,
                )
                log.warning("timeout %s -> %s", jid, status)

    def _kill(self, jid: str) -> None:
        r = self.running.pop(jid)
        r.proc.kill()
        r.proc.join(5)
        r.conn.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    Dispatcher(load()).run_forever()


if __name__ == "__main__":
    main()
