"""HTTP API. Stateless over the SQLite store: submit returns a job id (the
client's token) immediately; clients poll or long-poll for the result.

    POST /v1/jobs               {"kind", "payload", "key"?, "priority"?, "max_attempts"?, "timeout_s"?}
    GET  /v1/jobs/<id>?wait=15  long-poll until the job is terminal (cap 30s)
    GET  /v1/jobs?status=&limit=
    POST /v1/jobs/<id>/cancel
    GET  /v1/metrics?window=3600       throughput/latency per kind+model, latest laptop sample
    GET  /v1/metrics/samples?since=600 raw laptop samples (last N seconds)
    GET  /healthz
"""
import hmac
import time
from functools import wraps

from flask import Flask, g, jsonify, request

from . import store
from .config import load
from .handlers import REGISTRY

cfg = load()
app = Flask(__name__)


def db():
    if "db" not in g:
        g.db = store.connect(cfg.db_path)
    return g.db


@app.teardown_appcontext
def _close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def require_auth(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if cfg.api_key:
            header = request.headers.get("Authorization", "")
            token = header.removeprefix("Bearer ").strip() if header.startswith("Bearer ") else ""
            if not token or not hmac.compare_digest(token, cfg.api_key):
                return jsonify(error="unauthorized"), 401
        return f(*args, **kwargs)
    return wrapper


@app.get("/healthz")
def health():
    return jsonify(ok=True, kinds=sorted(REGISTRY), **store.stats(db(), cfg.lease_s))


@app.post("/v1/jobs")
@require_auth
def submit():
    body = request.get_json(silent=True) or {}
    kind = body.get("kind")
    if kind not in REGISTRY:
        return jsonify(error=f"unknown kind {kind!r}", kinds=sorted(REGISTRY)), 400
    try:
        job, created = store.submit(
            db(),
            kind=kind,
            payload=body.get("payload", {}),
            key=body.get("key"),
            priority=int(body.get("priority", 0)),
            max_attempts=max(1, int(body.get("max_attempts", cfg.default_max_attempts))),
            timeout_s=float(body.get("timeout_s", cfg.default_timeout_s)),
        )
    except (TypeError, ValueError) as e:
        return jsonify(error=str(e)), 400
    # 202 = accepted for processing; 200 = an active job with this key already exists.
    return jsonify(job=job, created=created), 202 if created else 200


@app.get("/v1/jobs/<job_id>")
@require_auth
def get_job(job_id):
    wait = min(float(request.args.get("wait", 0) or 0), cfg.max_wait_s)
    deadline = time.time() + wait
    while True:
        job = store.get(db(), job_id)
        if job is None:
            return jsonify(error="not found"), 404
        if job["status"] in store.TERMINAL or time.time() >= deadline:
            return jsonify(job=job)
        time.sleep(0.25)


@app.get("/v1/jobs")
@require_auth
def list_jobs():
    limit = min(int(request.args.get("limit", 50)), 500)
    return jsonify(jobs=store.list_jobs(db(), request.args.get("status"), limit))


@app.post("/v1/jobs/<job_id>/cancel")
@require_auth
def cancel(job_id):
    job = store.request_cancel(db(), job_id)
    if job is None:
        return jsonify(error="not found"), 404
    return jsonify(job=job)


@app.get("/v1/metrics")
@require_auth
def metrics():
    window = min(max(float(request.args.get("window", 3600)), 60), 7 * 86400)
    return jsonify(store.metrics(db(), window))


@app.get("/v1/metrics/samples")
@require_auth
def samples():
    since = min(max(float(request.args.get("since", 600)), 1), 7 * 86400)
    return jsonify(samples=store.samples_since(db(), time.time() - since))


if __name__ == "__main__":
    app.run(host=cfg.host, port=cfg.port, threaded=True)
