#!/usr/bin/env python3
"""Model serve monitor — live token-throughput dashboard for the local model servers.

Backends (toggle in the UI):
  qwen35  Qwen3.5-27B on MLX       :8321   (has /metrics: every request is visible)
  qwen25  qwen2.5-coder:7b, Ollama :11434  (no metrics: only probes run from here)
  jev     Qwen3-14B via LLM2Jev    :30000  (scoring API, no generation; external
                                            requests counted from /tmp/llm2jev.log)

  GET /, /app.js     dashboard
  GET /api/status    one-shot JSON snapshot of every endpoint
  GET /api/events    SSE: `snapshot` on connect, 1 Hz `tick` (all engines + live probe
                     state), `request` {backend, ...} whenever a job completes, and
                     ~5 Hz `live` while a probe is streaming
  GET /api/generate  SSE: ?backend=&prompt=&max_tokens= — streams a probe token by
                     token (Jev: one /v1/systemone evaluation). One probe per backend.
  GET /api/load      ?backend=&rps=&seconds=&max_tokens= — fires rps*seconds (max 400)
                     non-streaming requests at a fixed rate; progress arrives as SSE
                     `load` events. Every job is tagged normal / probe / load.
"""
from __future__ import annotations

import json
import os
import queue
import statistics
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST, PORT = "127.0.0.1", 8880
HERE = Path(__file__).resolve().parent
INDEX = HERE / "index.html"

BACKENDS: dict[str, dict] = {
    "qwen35": {"label": "Qwen3.5-27B", "kind": "mlx", "base": "http://127.0.0.1:8321"},
    "qwen25": {"label": "Qwen2.5-Coder-7B", "kind": "ollama", "base": "http://127.0.0.1:11434",
               "model": "qwen2.5-coder:7b"},
    "jev": {"label": "Jev · Qwen3-14B", "kind": "jev", "base": "http://127.0.0.1:30000",
            "model": "qwen3-14b-jev", "log": "/tmp/llm2jev.log"},
}

ENDPOINTS = {
    "health": "http://127.0.0.1:8321/health",
    "metrics": "http://127.0.0.1:8321/metrics",
    "models": "http://127.0.0.1:8321/v1/models",
    "cache": "http://127.0.0.1:8321/v1/cache/stats",
    "ollama_ps": "http://127.0.0.1:11434/api/ps",
    "ollama_version": "http://127.0.0.1:11434/api/version",
    "jev_health": "http://127.0.0.1:30000/health",
    "jev_models": "http://127.0.0.1:30000/v1/models",
    "compute": "http://127.0.0.1:8878/health",
    "dispatch": "http://127.0.0.1:8877/health",
}

JEV_QUESTIONS = {
    "quality": {"type": "score", "instructions": "How clear and well-specified is this request?",
                "criteria": ["unclear", "somewhat clear", "clear", "very clear", "excellent"]},
    "safe": {"type": "noul", "instructions": "Is this request safe to answer?"},
}

_subs: list[queue.Queue] = []
_subs_lock = threading.Lock()
_state_lock = threading.Lock()
_probe_locks = {b: threading.Lock() for b in BACKENDS}
_history = {b: deque(maxlen=200) for b in BACKENDS}
_counts = {b: {"completed": 0, "failed": 0} for b in BACKENDS}
_started = time.time()
_jev_skip = 0  # log lines produced by our own Jev probes, already recorded

# MLX /metrics records carry no request id, so jobs we send are matched back to
# their record by (prompt_tokens, completion_tokens) and completion time.
_pending: list[dict] = []
TAGS_FILE = HERE / "tags.json"
try:
    _tags: dict[float, str] = {float(k): v for k, v in json.loads(TAGS_FILE.read_text()).items()}
except (OSError, ValueError):
    _tags = {}
_load = {b: {"active": False, "total": 0, "sent": 0, "done": 0, "failed": 0, "rps": 0, "started": None}
         for b in BACKENDS}
# Load requests currently in flight, per backend: {i: {"id", "started", "prompt"}}.
# Jev and Ollama expose no in-flight count, so this is the only way their load
# requests show up individually under Active Jobs.
_inflight: dict[str, dict[int, dict]] = {b: {} for b in BACKENDS}
LOAD_MAX = 400


def expect_mlx(usage: dict | None, source: str) -> None:
    usage = usage or {}
    with _state_lock:
        _pending.append({"t": time.time(), "pt": usage.get("prompt_tokens"),
                         "ct": usage.get("completion_tokens"), "source": source})


def match_mlx(rec: dict) -> str | None:
    now = time.time()
    with _state_lock:
        _pending[:] = [p for p in _pending if now - p["t"] < 60]
        for i, p in enumerate(_pending):
            if (p["pt"] == rec.get("prompt_tokens") and p["ct"] == rec.get("completion_tokens")
                    and abs(p["t"] - (rec.get("timestamp_unix") or 0)) < 10):
                return _pending.pop(i)["source"]
    return None


def tag_of(rec: dict) -> str:
    return _tags.get(rec.get("timestamp_unix"), "normal")


def _jobs(backend: str) -> list[dict]:
    return sorted(_inflight[backend].values(), key=lambda j: j["id"])


def load_state(backend: str, **kw) -> dict:
    with _state_lock:
        _load[backend].update(kw)
        return {"backend": backend, **_load[backend], "jobs": _jobs(backend)}


def all_load() -> dict:
    with _state_lock:
        return {b: {**v, "jobs": _jobs(b)} for b, v in _load.items()}


def _idle() -> dict:
    return {"active": False, "tokens": 0, "tok_s": 0.0, "inst_tok_s": 0.0, "ttft_s": None, "elapsed_s": 0.0}


_live = {b: _idle() for b in BACKENDS}


def fetch(url: str, timeout: float = 4.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            raw = r.read()
            try:
                data = json.loads(raw.decode())
            except Exception:
                data = {"raw": raw.decode("utf-8", "replace")[:4000]}
            return r.status, data
    except Exception as e:
        return 0, {"error": str(e)}


def sse(event: str, data) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode()


def broadcast(event: str, data) -> None:
    msg = sse(event, data)
    with _subs_lock:
        for q in _subs:
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass


def set_live(backend: str, **kw) -> dict:
    with _state_lock:
        _live[backend].update(kw)
        return {"backend": backend, **_live[backend]}


def all_live() -> dict:
    with _state_lock:
        return {b: dict(v) for b, v in _live.items()}


def record_job(backend: str, rec: dict, ok: bool = True) -> None:
    with _state_lock:
        _counts[backend]["completed" if ok else "failed"] += 1
        if backend in _history:
            _history[backend].append(rec)
    broadcast("request", {"backend": backend, **rec})


# ---- per-backend snapshots -------------------------------------------------

def mlx_slots() -> int:
    """Concurrent decode slots (--max-num-seqs); /metrics doesn't report it."""
    try:
        for line in (HERE.parent / "mlx" / ".env").read_text().splitlines():
            if line.startswith("MLX_MAX_SEQS="):
                return int(line.split("=", 1)[1].strip())
    except (OSError, ValueError):
        pass
    return 1


def mlx_snapshot(m: dict, d: dict) -> dict:
    s = m.get("summary") or {}
    srv = m.get("server") or {}
    q = d.get("queue") or {}
    latest = m.get("latest") or {}
    return {
        "model": srv.get("loaded_model"),
        "context": srv.get("effective_context_limit"),
        "in_flight": s.get("in_flight"),
        "queue_depth": srv.get("request_queue_depth"),
        "completed": s.get("requests_completed"),
        "failed": s.get("requests_failed"),
        "avg_decode_tok_s": s.get("avg_decode_tok_s"),
        "avg_request_time_s": s.get("avg_request_time_s"),
        "generated_tokens_total": s.get("generated_tokens_total"),
        "prompt_tokens_total": s.get("prompt_tokens_total"),
        "uptime_s": s.get("uptime_s"),
        "last_request_at": s.get("last_request_at"),
        "last_error": s.get("last_error"),
        "memory_gb": latest.get("peak_memory_gb"),
        "dispatch_queued": q.get("queued"),
        "dispatch_running": (q.get("running") or {}).get("qwen"),
        "slots": mlx_slots(),
        "metrics": "full",
    }


def local_snapshot(backend: str, **extra) -> dict:
    with _state_lock:
        hist = list(_history[backend])
        counts = dict(_counts[backend])
        active = _live[backend]["active"]
        load_open = len(_inflight[backend])
    dec = [r["decode_tok_s"] for r in hist if r.get("decode_tok_s")]
    dur = [r["request_elapsed_s"] for r in hist if r.get("request_elapsed_s")]
    return {
        "model": BACKENDS[backend]["model"],
        "in_flight": int(active) + load_open,
        "queue_depth": None,
        "completed": counts["completed"],
        "failed": counts["failed"],
        "avg_decode_tok_s": statistics.fmean(dec) if dec else None,
        "avg_request_time_s": statistics.fmean(dur) if dur else None,
        "generated_tokens_total": sum(r.get("completion_tokens") or 0 for r in hist),
        "prompt_tokens_total": sum(r.get("prompt_tokens") or 0 for r in hist),
        "uptime_s": time.time() - _started,
        "last_request_at": hist[-1]["timestamp_unix"] if hist else None,
        "metrics": "probe-only",
        **extra,
    }


class JevLog:
    """Counts /v1/systemone requests in the Jev server log (it has no metrics API)."""

    def __init__(self, path: str) -> None:
        self.path, self.offset = path, None

    def poll(self) -> list[int]:
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return []
        if self.offset is None or size < self.offset:
            self.offset = size
            return []
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            chunk = f.read()
        self.offset += len(chunk)
        codes = []
        for line in chunk.decode("utf-8", "replace").splitlines():
            if '"POST /v1/systemone' in line:
                try:
                    codes.append(int(line.rsplit('" ', 1)[1].split()[0]))
                except (IndexError, ValueError):
                    pass
        return codes


def poller() -> None:
    global _jev_skip
    last_ts = None
    hold: list[tuple[float, dict]] = []  # new MLX records waiting briefly for a probe/load match
    jev_log = JevLog(BACKENDS["jev"]["log"])
    jev_log.poll()
    while True:
        t0 = time.time()
        engines = {}

        code, m = fetch(ENDPOINTS["metrics"], timeout=2)
        _, d = fetch(ENDPOINTS["dispatch"], timeout=2)
        if code:
            recs = sorted(m.get("recent") or [], key=lambda r: r.get("timestamp_unix") or 0)
            newest = recs[-1].get("timestamp_unix") if recs else None
            if last_ts is not None:
                hold += [(t0, r) for r in recs if (r.get("timestamp_unix") or 0) > last_ts]
            else:
                with _state_lock:
                    _history["qwen35"].extend({**r, "source": tag_of(r)} for r in recs)
            last_ts = max(filter(None, (last_ts, newest)), default=None)
            tagged_any = False
            for item in list(hold):
                seen, r = item
                src = match_mlx(r)
                if src or t0 - seen > 2.5:
                    hold.remove(item)
                    if src:
                        _tags[r["timestamp_unix"]] = src
                        tagged_any = True
                    if len(_tags) > 2000:
                        for k in sorted(_tags)[:500]:
                            _tags.pop(k)
                    tagged = {**r, "source": src or "normal"}
                    with _state_lock:
                        _history["qwen35"].append(tagged)
                    broadcast("request", {"backend": "qwen35", **tagged})
            if tagged_any:
                try:
                    TAGS_FILE.write_text(json.dumps(_tags))
                except OSError:
                    pass
            engines["qwen35"] = {"up": True, "engine": mlx_snapshot(m, d)}
        else:
            engines["qwen35"] = {"up": False, "error": m.get("error"), "engine": {}}

        code, ps = fetch(ENDPOINTS["ollama_ps"], timeout=2)
        loaded = next((x for x in ps.get("models") or [] if x.get("name") == BACKENDS["qwen25"]["model"]), None) if code else None
        engines["qwen25"] = {"up": bool(code), "engine": local_snapshot(
            "qwen25", loaded=bool(loaded), memory_gb=(loaded or {}).get("size_vram", 0) / 1e9 or None,
            context=(loaded or {}).get("context_length"))}

        for status in jev_log.poll():
            with _state_lock:
                own = _jev_skip > 0
                _jev_skip -= own
            if own:
                continue
            record_job("jev", {"timestamp_unix": time.time(), "endpoint": "/v1/systemone", "source": "normal",
                               "stream": False, "finish_reason": str(status)}, ok=status < 400)
        code, _ = fetch(ENDPOINTS["jev_health"], timeout=2)
        engines["jev"] = {"up": bool(code), "engine": local_snapshot("jev")}

        broadcast("tick", {"t": t0, "engines": engines, "live": all_live(), "load": all_load()})
        time.sleep(max(0.0, 1.0 - (time.time() - t0)))


# ---- load test -------------------------------------------------------------

def _load_one(backend: str, i: int, prompt: str, max_tokens: int) -> None:
    t0 = time.time()
    with _state_lock:
        _inflight[backend][i] = {"id": i, "started": t0, "prompt": prompt[:80]}
    try:
        _load_request(backend, i, prompt, max_tokens, t0)
    finally:
        with _state_lock:
            _inflight[backend].pop(i, None)
    s = load_state(backend)
    if s["done"] + s["failed"] >= s["total"]:
        s = load_state(backend, active=False, finished=time.time())
    broadcast("load", s)


def _load_request(backend: str, i: int, prompt: str, max_tokens: int, t0: float) -> None:
    global _jev_skip
    cfg = BACKENDS[backend]
    try:
        if cfg["kind"] == "jev":
            body = {"state": f"{prompt} (#{i})", "model": cfg["model"], "questions": JEV_QUESTIONS}
            url = f"{cfg['base']}/v1/systemone"
            with _state_lock:
                _jev_skip += 1
        else:
            model = cfg.get("model")
            if cfg["kind"] == "mlx":
                model = (fetch(ENDPOINTS["health"], timeout=3)[1].get("loaded_model")) or "default"
            body = {"model": model, "max_tokens": max_tokens,
                    "messages": [{"role": "user", "content": f"{prompt} (request #{i})"}]}
            url = f"{cfg['base']}/v1/chat/completions"
        req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=1800) as r:
            resp = json.load(r)
        el = time.time() - t0
        usage = resp.get("usage") or {}
        if cfg["kind"] == "mlx":
            expect_mlx(usage, "load")
        elif cfg["kind"] == "jev":
            pt = usage.get("input_tokens") or 0
            record_job(backend, {"timestamp_unix": time.time(), "endpoint": "/v1/systemone", "source": "load",
                                 "stream": False, "finish_reason": "200", "prompt_tokens": pt,
                                 "completion_tokens": 0, "request_elapsed_s": el, "prefill_tok_s": pt / el})
        else:
            ct = usage.get("completion_tokens") or 0
            record_job(backend, {"timestamp_unix": time.time(), "endpoint": "/v1/chat/completions", "source": "load",
                                 "stream": False, "finish_reason": (resp.get("choices") or [{}])[0].get("finish_reason"),
                                 "prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": ct,
                                 "request_elapsed_s": el})
        with _state_lock:
            _load[backend]["done"] += 1
    except Exception:
        if cfg["kind"] != "mlx":
            record_job(backend, {"timestamp_unix": time.time(), "endpoint": "load", "source": "load",
                                 "finish_reason": "error", "request_elapsed_s": time.time() - t0}, ok=False)
        with _state_lock:
            _load[backend]["failed"] += 1


def _load_run(backend: str, total: int, rps: float, prompt: str, max_tokens: int) -> None:
    t0 = time.time()
    for i in range(total):
        delay = t0 + i / rps - time.time()
        if delay > 0:
            time.sleep(delay)
        threading.Thread(target=_load_one, args=(backend, i, prompt, max_tokens), daemon=True).start()
        broadcast("load", load_state(backend, sent=i + 1))


def start_load(qs: dict) -> tuple[int, dict]:
    def arg(name, default, cast=float):
        try:
            return cast((qs.get(name) or [default])[0])
        except ValueError:
            return cast(default)

    backend = arg("backend", "qwen35", str)
    if backend not in BACKENDS:
        return 400, {"error": f"unknown backend {backend}"}
    rps = max(0.1, min(100.0, arg("rps", 40)))
    seconds = max(0.1, min(60.0, arg("seconds", 1)))
    max_tokens = max(8, min(1024, arg("max_tokens", 32, int)))
    prompt = arg("prompt", "In one sentence, why do penguins huddle?", str)
    total = min(LOAD_MAX, max(1, round(rps * seconds)))
    with _state_lock:
        if _load[backend]["active"]:
            return 409, {"error": "a load test is already running on this backend", **_load[backend]}
        _load[backend].update(active=True, total=total, sent=0, done=0, failed=0, rps=rps,
                              max_tokens=max_tokens, started=time.time(), finished=None)
    broadcast("load", load_state(backend))
    threading.Thread(target=_load_run, args=(backend, total, rps, prompt, max_tokens), daemon=True).start()
    return 200, {"backend": backend, "total": total, "rps": rps, "max_tokens": max_tokens}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sse_headers(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def _write(self, msg: bytes) -> None:
        self.wfile.write(msg)
        self.wfile.flush()

    def do_GET(self):
        url = urlparse(self.path)
        static = {"/": (INDEX, "text/html"), "/index.html": (INDEX, "text/html"),
                  "/app.js": (HERE / "app.js", "text/javascript")}
        if url.path in static:
            path, ctype = static[url.path]
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", f"{ctype}; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif url.path == "/api/status":
            self._json(200, {k: dict(zip(("http", "data"), fetch(u))) for k, u in ENDPOINTS.items()})
        elif url.path == "/api/events":
            self.events()
        elif url.path == "/api/generate":
            self.generate(parse_qs(url.query))
        elif url.path == "/api/load":
            code, obj = start_load(parse_qs(url.query))
            self._json(code, obj)
        else:
            self.send_response(404)
            self.end_headers()

    def events(self) -> None:
        self._sse_headers()
        q: queue.Queue = queue.Queue(maxsize=512)
        with _subs_lock:
            _subs.append(q)
        try:
            with _state_lock:
                recent = {b: list(h) for b, h in _history.items()}
            self._write(sse("snapshot", {
                "backends": {b: {"label": v["label"], "kind": v["kind"], "base": v["base"]} for b, v in BACKENDS.items()},
                "recent": recent,
                "live": all_live(),
                "load": all_load(),
            }))
            while True:
                try:
                    self._write(q.get(timeout=15))
                except queue.Empty:
                    self._write(b": ping\n\n")
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with _subs_lock:
                if q in _subs:
                    _subs.remove(q)

    def generate(self, qs: dict) -> None:
        backend = (qs.get("backend") or ["qwen35"])[0]
        prompt = (qs.get("prompt") or ["Write a vivid 200-word short story about a penguin who audits expense reports."])[0]
        try:
            max_tokens = max(16, min(2048, int((qs.get("max_tokens") or ["256"])[0])))
        except ValueError:
            max_tokens = 256
        self._sse_headers()
        if backend not in BACKENDS:
            self._write(sse("fail", {"error": f"unknown backend {backend}"}))
            return
        if not _probe_locks[backend].acquire(blocking=False):
            self._write(sse("fail", {"error": "a probe is already running on this backend"}))
            return
        try:
            if BACKENDS[backend]["kind"] == "jev":
                self._jev_probe(prompt)
            else:
                self._stream_probe(backend, prompt, max_tokens)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            global _jev_skip
            if backend == "jev" and not isinstance(e, urllib.error.HTTPError):
                with _state_lock:
                    _jev_skip = max(0, _jev_skip - 1)
            if BACKENDS[backend]["kind"] != "mlx":
                record_job(backend, {"timestamp_unix": time.time(), "endpoint": "probe", "source": "probe",
                                     "finish_reason": "error"}, ok=False)
            try:
                self._write(sse("fail", {"error": str(e)}))
            except OSError:
                pass
        finally:
            broadcast("live", set_live(backend, active=False, inst_tok_s=0.0))
            _probe_locks[backend].release()

    def _stream_probe(self, backend: str, prompt: str, max_tokens: int) -> None:
        cfg = BACKENDS[backend]
        model = cfg.get("model")
        if cfg["kind"] == "mlx":
            _, health = fetch(ENDPOINTS["health"], timeout=3)
            model = health.get("loaded_model") or "default"
        body = json.dumps({
            "model": model,
            "stream": True,
            "max_tokens": max_tokens,
            "stream_options": {"include_usage": True},
            "messages": [{"role": "user", "content": prompt}],
        }).encode()
        req = urllib.request.Request(f"{cfg['base']}/v1/chat/completions", body, {"Content-Type": "application/json"})

        t0 = time.time()
        first: float | None = None
        n = 0
        window: deque[float] = deque()
        last_push = 0.0
        usage = None
        server_rate = None
        state = set_live(backend, active=True, tokens=0, tok_s=0.0, inst_tok_s=0.0, ttft_s=None, elapsed_s=0.0)
        self._write(sse("start", {"backend": backend, "model": model, "max_tokens": max_tokens}))
        broadcast("live", state)

        finish = None
        with urllib.request.urlopen(req, timeout=900) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    d = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if d.get("usage"):
                    usage = d["usage"]
                rate = (d.get("timings") or {}).get("predicted_per_second")
                if rate:
                    server_rate = rate
                text = ""
                for ch in d.get("choices") or []:
                    delta = ch.get("delta") or {}
                    text += (delta.get("content") or "") + (delta.get("reasoning_content") or delta.get("reasoning") or "")
                    finish = ch.get("finish_reason") or finish
                if not text:
                    continue

                now = time.time()
                if first is None:
                    first = now
                n += 1
                window.append(now)
                while window and now - window[0] > 1.0:
                    window.popleft()
                decode_s = now - first
                state = set_live(
                    backend,
                    tokens=n,
                    ttft_s=first - t0,
                    elapsed_s=now - t0,
                    tok_s=(n - 1) / decode_s if decode_s > 0 else 0.0,
                    inst_tok_s=len(window) / min(1.0, decode_s) if decode_s > 0.05 else 0.0,
                )
                self._write(sse("token", {"text": text, **state}))
                if now - last_push >= 0.2:
                    broadcast("live", state)
                    last_push = now

        final = set_live(backend)
        if cfg["kind"] == "mlx":
            expect_mlx(usage, "probe")
        else:
            usage = usage or {}
            ttft = final.get("ttft_s")
            record_job(backend, {
                "timestamp_unix": time.time(), "endpoint": "/v1/chat/completions", "source": "probe",
                "stream": True, "model": model, "finish_reason": finish or "stop",
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens") or final["tokens"],
                "ttft_s": ttft, "request_elapsed_s": time.time() - t0,
                "decode_tok_s": final["tok_s"] or None,
                "prefill_tok_s": (usage.get("prompt_tokens") or 0) / ttft if ttft else None,
            })
        self._write(sse("done", {**final, "usage": usage, "mlx_tok_s": server_rate}))

    def _jev_probe(self, prompt: str) -> None:
        cfg = BACKENDS["jev"]
        global _jev_skip
        body = json.dumps({"state": prompt, "model": cfg["model"], "questions": JEV_QUESTIONS}).encode()
        req = urllib.request.Request(f"{cfg['base']}/v1/systemone", body, {"Content-Type": "application/json"})
        with _state_lock:
            _jev_skip += 1
        t0 = time.time()
        broadcast("live", set_live("jev", active=True, tokens=0, tok_s=0.0, inst_tok_s=0.0, ttft_s=None, elapsed_s=0.0))
        self._write(sse("start", {"backend": "jev", "model": cfg["model"]}))
        with urllib.request.urlopen(req, timeout=600) as r:
            resp = json.load(r)
        el = time.time() - t0
        usage = resp.get("usage") or {}
        pt = usage.get("input_tokens") or 0
        lines = []
        for qid, a in (resp.get("answers") or {}).items():
            if a.get("type") == "score":
                label = (a.get("legend") or {}).get(str(round(a["score"])), "")
                lines.append(f"{qid}: score {a['score']:.2f} ({label}), confidence {a.get('confidence', 0):.2f}")
            elif a.get("type") == "noul":
                lines.append(f"{qid}: P(true) = {a['noul']:.4f}")
            else:
                lines.append(f"{qid}: {json.dumps(a)}")
        state = set_live("jev", tokens=pt, ttft_s=el, elapsed_s=el, tok_s=pt / el if el else 0.0, inst_tok_s=0.0)
        self._write(sse("token", {"text": "\n".join(lines), **state}))
        record_job("jev", {
            "timestamp_unix": time.time(), "endpoint": "/v1/systemone", "source": "probe", "stream": False,
            "model": cfg["model"], "finish_reason": "200", "prompt_tokens": pt,
            "completion_tokens": usage.get("output_tokens") or 0, "ttft_s": el, "request_elapsed_s": el,
            "prefill_tok_s": pt / el if el else None,
        })
        self._write(sse("done", {**state, "usage": usage, "answers": resp.get("answers")}))


if __name__ == "__main__":
    threading.Thread(target=poller, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"Model monitor → http://{HOST}:{PORT}", flush=True)
    server.serve_forever()
