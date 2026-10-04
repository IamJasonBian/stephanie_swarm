"""SQLite job store. The `jobs` table *is* the queue — there is no separate
queue table, so a job can never be "dequeued but not started" (the gap the
delete-then-POST queue handler in the amazon server.py has).

Every write that ends or changes a running job is a compare-and-set on
(status='running', worker=<me>): if a lease expired and another dispatcher
already requeued/re-ran the job, a late result from the original worker is
dropped instead of clobbering the newer run.

Connections are per-thread / per-process (sqlite objects can't be shared
across threads), WAL so API reads never block the dispatcher's writes.
"""
import json
import os
import sqlite3
import time
import uuid
from typing import Any

ACTIVE = ("queued", "running")
TERMINAL = ("succeeded", "failed", "cancelled")

SCHEMA = """
create table if not exists jobs (
  id               text primary key,
  kind             text not null,
  payload          text not null,
  key              text,
  priority         integer not null default 0,
  status           text not null default 'queued',
  attempts         integer not null default 0,
  max_attempts     integer not null default 3,
  timeout_s        real not null,
  run_after        real not null,
  result           text,
  error            text,
  checkpoint       text,
  worker           text,
  heartbeat_at     real,
  cancel_requested integer not null default 0,
  created_at       real not null,
  started_at       real,
  finished_at      real
);
-- Duplicate guard: at most one active job per key (like the per-brand
-- `processing` check), but a finished key can be submitted again.
create unique index if not exists jobs_active_key
  on jobs(key) where key is not null and status in ('queued', 'running');
create index if not exists jobs_claim on jobs(status, priority desc, created_at);
create index if not exists jobs_worker on jobs(worker) where status = 'running';
create index if not exists jobs_finished on jobs(finished_at);
-- Periodic laptop/capacity samples written by each dispatcher.
create table if not exists samples (
  ts     real not null,
  worker text not null,
  data   text not null
);
create index if not exists samples_ts on samples(ts);
"""

MIGRATIONS = [
    "alter table jobs add column progress text",  # live progress (thinking / tool chain) for clients
]


def connect(db_path: str) -> sqlite3.Connection:
    if db_path != ":memory:":
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("pragma journal_mode=wal")
    conn.execute("pragma synchronous=normal")
    conn.execute("pragma busy_timeout=10000")
    conn.executescript(SCHEMA)
    for stmt in MIGRATIONS:
        try:
            conn.execute(stmt)
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e):
                raise
    return conn


def to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    d = dict(row)
    for k in ("payload", "result", "checkpoint", "progress"):
        if d.get(k) is not None:
            d[k] = json.loads(d[k])
    d["cancel_requested"] = bool(d["cancel_requested"])
    return d


def submit(
    conn: sqlite3.Connection,
    *,
    kind: str,
    payload: Any,
    key: str | None = None,
    priority: int = 0,
    max_attempts: int = 3,
    timeout_s: float = 600,
) -> tuple[dict[str, Any], bool]:
    """Insert a job. Returns (job, created); created=False means an active job
    with the same key already exists and that job is returned instead."""
    now = time.time()
    job_id = uuid.uuid4().hex
    try:
        conn.execute(
            """insert into jobs (id, kind, payload, key, priority, max_attempts, timeout_s, run_after, created_at)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (job_id, kind, json.dumps(payload), key, priority, max_attempts, timeout_s, now, now),
        )
    except sqlite3.IntegrityError:
        existing = conn.execute(
            "select * from jobs where key = ? and status in ('queued', 'running')", (key,)
        ).fetchone()
        if existing is None:  # finished between our insert and select — retry once
            return submit(conn, kind=kind, payload=payload, key=key, priority=priority,
                          max_attempts=max_attempts, timeout_s=timeout_s)
        return to_dict(existing), False
    return get(conn, job_id), True


def get(conn: sqlite3.Connection, job_id: str) -> dict[str, Any] | None:
    return to_dict(conn.execute("select * from jobs where id = ?", (job_id,)).fetchone())


def list_jobs(conn: sqlite3.Connection, status: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    if status:
        rows = conn.execute(
            "select * from jobs where status = ? order by created_at desc limit ?", (status, limit)
        )
    else:
        rows = conn.execute("select * from jobs order by created_at desc limit ?", (limit,))
    return [to_dict(r) for r in rows]


def stats(conn: sqlite3.Connection, lease_s: float) -> dict[str, Any]:
    counts = {s: 0 for s in ACTIVE + TERMINAL}
    for row in conn.execute("select status, count(*) n from jobs group by status"):
        counts[row["status"]] = row["n"]
    live = conn.execute(
        "select distinct worker from jobs where status = 'running' and heartbeat_at >= ?",
        (time.time() - lease_s,),
    ).fetchall()
    return {"jobs": counts, "busy_dispatchers": [r["worker"] for r in live]}


def request_cancel(conn: sqlite3.Connection, job_id: str) -> dict[str, Any] | None:
    """Queued jobs are cancelled immediately; running ones are flagged and the
    owning dispatcher kills the process on its next tick."""
    now = time.time()
    conn.execute(
        "update jobs set status = 'cancelled', finished_at = ? where id = ? and status = 'queued'",
        (now, job_id),
    )
    conn.execute("update jobs set cancel_requested = 1 where id = ? and status = 'running'", (job_id,))
    return get(conn, job_id)


# ---- dispatcher side -------------------------------------------------------

def claim(conn: sqlite3.Connection, worker: str, n: int) -> list[dict[str, Any]]:
    """Atomically move up to n runnable queued jobs to running for `worker`.
    A single UPDATE ... RETURNING, so concurrent dispatchers never double-claim."""
    if n <= 0:
        return []
    now = time.time()
    rows = conn.execute(
        """update jobs
              set status = 'running', worker = ?, attempts = attempts + 1,
                  heartbeat_at = ?, started_at = ?, error = null
            where id in (select id from jobs
                          where status = 'queued' and run_after <= ?
                          order by priority desc, created_at
                          limit ?)
           returning *""",
        (worker, now, now, now, n),
    ).fetchall()
    jobs = [to_dict(r) for r in rows]
    jobs.sort(key=lambda j: (-j["priority"], j["created_at"]))
    return jobs


def heartbeat(conn: sqlite3.Connection, worker: str) -> None:
    conn.execute(
        "update jobs set heartbeat_at = ? where worker = ? and status = 'running'", (time.time(), worker)
    )


def cancel_requested_ids(conn: sqlite3.Connection, worker: str) -> set[str]:
    rows = conn.execute(
        "select id from jobs where worker = ? and status = 'running' and cancel_requested = 1", (worker,)
    )
    return {r["id"] for r in rows}


def finish(
    conn: sqlite3.Connection, job_id: str, worker: str, status: str,
    *, result: Any = None, error: str | None = None,
) -> bool:
    assert status in TERMINAL
    cur = conn.execute(
        """update jobs set status = ?, result = ?, error = ?, finished_at = ?
            where id = ? and worker = ? and status = 'running'""",
        (status, json.dumps(result) if result is not None else None, error, time.time(), job_id, worker),
    )
    return cur.rowcount == 1


def retry_or_fail(
    conn: sqlite3.Connection, job_id: str, worker: str, error: str,
    *, backoff_s: float, permanent: bool = False,
) -> str | None:
    """After a failed attempt: requeue (with linear backoff) while attempts
    remain, else mark failed. The checkpoint is kept, so the next attempt
    resumes where this one left off. Returns the new status, or None if the
    job was no longer ours."""
    now = time.time()
    row = conn.execute(
        """update jobs
              set status = case when ? or attempts >= max_attempts then 'failed' else 'queued' end,
                  error = ?,
                  run_after = ? + ? * attempts,
                  finished_at = case when ? or attempts >= max_attempts then ? else null end,
                  worker = case when ? or attempts >= max_attempts then worker else null end
            where id = ? and worker = ? and status = 'running'
           returning status""",
        (permanent, error, now, backoff_s, permanent, now, permanent, job_id, worker),
    ).fetchone()
    return row["status"] if row else None


def release(conn: sqlite3.Connection, job_id: str, worker: str, reason: str) -> None:
    """Hand a job back without charging an attempt (graceful shutdown)."""
    conn.execute(
        """update jobs set status = 'queued', worker = null, attempts = max(attempts - 1, 0),
                          error = ?, run_after = ?
            where id = ? and worker = ? and status = 'running'""",
        (reason, time.time(), job_id, worker),
    )


def recover_expired(conn: sqlite3.Connection, lease_s: float, backoff_s: float) -> list[dict[str, Any]]:
    """Requeue/fail running jobs whose dispatcher stopped heartbeating.

    Replaces both `reset_processing_rows_to_failed` (startup) and
    `reconcile_stuck_tasks` (timeout scan) from the amazon server: it's safe
    to run from any dispatcher at any time because it only touches jobs whose
    owner is provably silent — unlike a blanket startup reset, it can't stomp
    on another live dispatcher's work. Long jobs are fine as long as their
    dispatcher keeps heartbeating; per-job runtime limits are timeout_s."""
    now = time.time()
    rows = conn.execute(
        """update jobs
              set status = case when cancel_requested then 'cancelled'
                                when attempts >= max_attempts then 'failed'
                                else 'queued' end,
                  error = 'lease expired: dispatcher ' || coalesce(worker, '?') || ' stopped heartbeating',
                  run_after = ? + ? * attempts,
                  finished_at = case when cancel_requested or attempts >= max_attempts then ? else null end,
                  worker = null
            where status = 'running' and heartbeat_at < ?
           returning id, status""",
        (now, backoff_s, now, now - lease_s),
    ).fetchall()
    return [dict(r) for r in rows]


def save_checkpoint(conn: sqlite3.Connection, job_id: str, worker: str, state: Any) -> bool:
    cur = conn.execute(
        "update jobs set checkpoint = ? where id = ? and worker = ? and status = 'running'",
        (json.dumps(state), job_id, worker),
    )
    return cur.rowcount == 1


def save_progress(conn: sqlite3.Connection, job_id: str, worker: str, state: Any) -> bool:
    cur = conn.execute(
        "update jobs set progress = ? where id = ? and worker = ? and status = 'running'",
        (json.dumps(state), job_id, worker),
    )
    return cur.rowcount == 1


# ---- metrics ----------------------------------------------------------------

def add_sample(conn: sqlite3.Connection, worker: str, data: dict[str, Any], keep_s: float = 7 * 86400) -> None:
    now = time.time()
    conn.execute("insert into samples (ts, worker, data) values (?, ?, ?)", (now, worker, json.dumps(data)))
    conn.execute("delete from samples where ts < ?", (now - keep_s,))


def _pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    values = sorted(values)
    return round(values[min(len(values) - 1, int(q * len(values)))], 3)


def metrics(conn: sqlite3.Connection, window_s: float = 3600) -> dict[str, Any]:
    """Throughput / latency per kind+model over the window, plus the latest
    laptop sample per dispatcher. Token counts come from job results
    (`usage`, `tokens_per_s`, `ttft_s`) as the llm/agent handlers report them."""
    since = time.time() - window_s
    rows = conn.execute(
        """select kind, status, created_at, started_at, finished_at,
                  json_extract(result, '$.model') model,
                  json_extract(result, '$.usage.prompt_tokens') pt,
                  json_extract(result, '$.usage.completion_tokens') ct,
                  json_extract(result, '$.tokens_per_s') tps,
                  json_extract(result, '$.ttft_s') ttft
             from jobs where finished_at >= ?""",
        (since,),
    ).fetchall()
    groups: dict[str, dict[str, Any]] = {}
    for r in rows:
        g = groups.setdefault(f"{r['kind']}:{r['model'] or '-'}", {
            "kind": r["kind"], "model": r["model"], "jobs": 0, "succeeded": 0, "failed": 0, "cancelled": 0,
            "prompt_tokens": 0, "completion_tokens": 0, "_lat": [], "_wait": [], "_tps": [], "_ttft": [],
        })
        g["jobs"] += 1
        g[r["status"]] = g.get(r["status"], 0) + 1
        g["prompt_tokens"] += r["pt"] or 0
        g["completion_tokens"] += r["ct"] or 0
        if r["started_at"]:
            g["_wait"].append(r["started_at"] - r["created_at"])
            g["_lat"].append(r["finished_at"] - r["started_at"])
        if r["tps"]:
            g["_tps"].append(r["tps"])
        if r["ttft"]:
            g["_ttft"].append(r["ttft"])
    for g in groups.values():
        lat, wait, tps, ttft = g.pop("_lat"), g.pop("_wait"), g.pop("_tps"), g.pop("_ttft")
        g.update(
            latency_p50_s=_pct(lat, 0.5), latency_p95_s=_pct(lat, 0.95),
            queue_wait_p50_s=_pct(wait, 0.5), queue_wait_p95_s=_pct(wait, 0.95),
            tokens_per_s_avg=round(sum(tps) / len(tps), 1) if tps else None,
            ttft_p50_s=_pct(ttft, 0.5),
            jobs_per_min=round(g["jobs"] / (window_s / 60), 3),
            output_tokens_per_min=round(g["completion_tokens"] / (window_s / 60), 1),
        )
    latest = conn.execute(
        """select s.worker, s.ts, s.data from samples s
             join (select worker, max(ts) ts from samples group by worker) m
               on m.worker = s.worker and m.ts = s.ts"""
    ).fetchall()
    return {
        "window_s": window_s,
        "throughput": sorted(groups.values(), key=lambda g: -g["jobs"]),
        "machines": [{"worker": r["worker"], "age_s": round(time.time() - r["ts"], 1), **json.loads(r["data"])}
                     for r in latest],
    }


def samples_since(conn: sqlite3.Connection, since: float, limit: int = 2000) -> list[dict[str, Any]]:
    rows = conn.execute("select ts, worker, data from samples where ts >= ? order by ts limit ?", (since, limit))
    return [{"ts": r["ts"], "worker": r["worker"], **json.loads(r["data"])} for r in rows]
