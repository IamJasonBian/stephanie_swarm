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
                     `load` events. Every job is tagged normal / probe / load / chat.

Support chat → reimbursement engine:
  POST /api/chat          {session, messages, mode: engine|quick, backend} → SSE:
                          `triage` (Jev: domain, objection, has_facts), `status`,
                          `token` (quick mode), `reply`, `fail`. Engine mode runs the
                          reimbursement-advocate harness on compute (web_search);
                          quick mode streams the same prompt straight from a model.
  POST /api/chat/outcome  {session, outcome: won|partial|lost, note, summary}
  GET  /api/chat/engine   profile, lessons block, penguin memory stats
  Turns and outcomes go to the penguin bot's data/turns.jsonl + cases.jsonl, so
  outcomes recorded here feed its "Lessons from past cases" block and vice versa.
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
from datetime import datetime, timezone
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

# Jev can't generate, so a Jev job is generate-then-judge: the 7B writes the
# response, Jev scores that response against the request in one prefill.
JEV_QUESTIONS = {
    "quality": {"type": "score", "instructions": "How well does the response answer the request?",
                "criteria": ["poor", "weak", "adequate", "good", "excellent"]},
    "on_topic": {"type": "noul", "instructions": "Does the response directly address the request?"},
    "safe": {"type": "noul", "instructions": "Is the response safe and appropriate?"},
}
JEV_GENERATOR = "qwen25"


def jev_job(prompt: str, max_tokens: int) -> dict:
    """Generate with JEV_GENERATOR, then judge with Jev. Returns text, verdict lines, timings, usage."""
    gen = BACKENDS[JEV_GENERATOR]
    t0 = time.time()
    body = {"model": gen["model"], "max_tokens": max_tokens, "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request(f"{gen['base']}/v1/chat/completions", json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        g = json.load(r)
    text = (((g.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
    gen_s = time.time() - t0

    jev = BACKENDS["jev"]
    body = {"model": jev["model"], "state": f"Request: {prompt}\n\nResponse: {text}", "questions": JEV_QUESTIONS}
    req = urllib.request.Request(f"{jev['base']}/v1/systemone", json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        verdict = json.load(r)
    return {"text": text, "lines": jev_lines(verdict), "answers": verdict.get("answers"),
            "gen_s": gen_s, "judge_s": time.time() - t0 - gen_s,
            "gen_tokens": (g.get("usage") or {}).get("completion_tokens") or 0,
            "usage": verdict.get("usage") or {}}

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


def jev_lines(resp: dict) -> list[str]:
    """Human-readable lines for a /v1/systemone response's answers."""
    lines = []
    for qid, a in (resp.get("answers") or {}).items():
        if a.get("type") == "score":
            label = (a.get("legend") or {}).get(str(round(a["score"])), "")
            lines.append(f"{qid}: score {a['score']:.2f} ({label}), confidence {a.get('confidence', 0):.2f}")
        elif a.get("type") == "noul":
            lines.append(f"{qid}: P(true) = {a['noul']:.4f}")
        elif a.get("type") == "choice":
            lines.append(f"{qid}: {a['choice']} (p={a['probabilities'].get(a['choice'], 0):.2f})")
        else:
            lines.append(f"{qid}: {json.dumps(a)}")
    return lines


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
                src = match_mlx(r) or chat_window_tag(r)
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
            with _state_lock:
                _jev_skip += 1
            j = jev_job(prompt, max_tokens)
            el = time.time() - t0
            broadcast("load_output", {"backend": backend, "id": i, "ok": True, "elapsed_s": el,
                                      "text": f"{j['text']}\n-- jev ({j['judge_s']:.2f}s): " + " · ".join(j["lines"])})
            pt = j["usage"].get("input_tokens") or 0
            record_job(backend, {"timestamp_unix": time.time(), "endpoint": "/v1/systemone", "source": "load",
                                 "stream": False, "finish_reason": "200", "prompt_tokens": pt,
                                 "completion_tokens": 0, "request_elapsed_s": el,
                                 "prefill_tok_s": pt / j["judge_s"] if j["judge_s"] else None})
            with _state_lock:
                _load[backend]["done"] += 1
            return
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
        text = ((resp.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        broadcast("load_output", {"backend": backend, "id": i, "ok": True, "elapsed_s": el, "text": text.strip()})
        if cfg["kind"] == "mlx":
            expect_mlx(usage, "load")
        else:
            ct = usage.get("completion_tokens") or 0
            record_job(backend, {"timestamp_unix": time.time(), "endpoint": "/v1/chat/completions", "source": "load",
                                 "stream": False, "finish_reason": (resp.get("choices") or [{}])[0].get("finish_reason"),
                                 "prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": ct,
                                 "request_elapsed_s": el})
        with _state_lock:
            _load[backend]["done"] += 1
    except Exception as e:
        broadcast("load_output", {"backend": backend, "id": i, "ok": False,
                                  "elapsed_s": time.time() - t0, "text": f"[error] {e}"})
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
    rps = max(0.1, min(100.0, arg("rps", 10)))
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


# ---- support chat → reimbursement engine -----------------------------------

SERVICES = HERE.parent
PROFILE_NAME = "reimbursement-advocate"
PROFILE_PATH = SERVICES.parent / "config" / "harnesses" / f"{PROFILE_NAME}.json"
PENGUIN_DATA = Path(os.environ.get("PENGUIN_DATA_DIR") or SERVICES / "telegram-penguin" / "data")
TURNS, CASES = PENGUIN_DATA / "turns.jsonl", PENGUIN_DATA / "cases.jsonl"
COMPUTE = "http://127.0.0.1:8878"
OUTCOMES = ("won", "partial", "lost", "pending")

TRIAGE_DOMAINS = {
    "employer_expense": "Employer or corporate expense reimbursement (expense report, corporate card, per diem).",
    "card_chargeback": "Credit or debit card dispute or chargeback with the card issuer.",
    "bank_transfer": "Bank, ACH, wire, Zelle or other payment-app transfer problem.",
    "marketplace_platform": "Refund from an online marketplace or platform (Amazon, PayPal, app store, eBay).",
    "travel": "Airline, hotel, rental car, rideshare or other travel refund or compensation.",
    "healthcare": "Medical billing, insurance claim, HSA or FSA reimbursement.",
    "subscription_bnpl": "Subscription, recurring charge, free-trial conversion or buy-now-pay-later.",
    "warranty_price": "Warranty, defective product, or price-protection / price-adjustment claim.",
    "shipping": "Lost, late or damaged package or shipping claim.",
    "tickets_events": "Event, concert or ticket refund.",
    "insurance_other": "Insurance claim or another kind of refund not listed.",
}
TRIAGE_OBJECTIONS = {
    "none_yet": "No objection yet; the user is asking how to start or what to do.",
    "no_refund_policy": "The company says it has a no-refund or final-sale policy.",
    "past_deadline": "The company says the request is too late or past a deadline or window.",
    "authorized_charge": "The issuer or bank says the charge was authorized or valid.",
    "missing_proof": "The user lacks a receipt, proof or documentation, or was asked for more.",
    "not_covered": "The employer, insurer or policy says it is not covered or not eligible.",
    "unresponsive": "The company is ignoring the user, stalling, or keeps transferring them.",
    "credit_only": "Only store credit, a voucher or a partial refund was offered.",
    "denied_closed": "A claim or dispute was already denied or closed.",
    "fraud_unrecognized": "The user does not recognize the charge or suspects fraud.",
}


def triage_questions() -> dict:
    return {
        "domain": {"type": "choice", "instructions": "Which reimbursement area is this conversation about?",
                   "criteria": TRIAGE_DOMAINS},
        "objection": {"type": "choice", "instructions": "What obstacle or objection is the user facing right now?",
                      "criteria": TRIAGE_OBJECTIONS},
        "has_facts": {"type": "noul", "instructions":
                      "Does the conversation state the amount, the company or merchant, and the date?"},
    }


def env_value(key: str) -> str | None:
    """Read one key from services/.env without exposing the rest."""
    try:
        for line in (SERVICES / ".env").read_text().splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip().strip("'\"") or None
    except OSError:
        pass
    return None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read_jsonl(path: Path, limit: int = 10_000) -> list[dict]:
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return []
    out = []
    for line in lines[-limit:]:
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


_jsonl_lock = threading.Lock()


def append_jsonl(path: Path, obj: dict) -> None:
    with _jsonl_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as f:
            f.write(json.dumps(obj) + "\n")


def lessons_block(max_n: int = 12) -> str | None:
    """Same block the penguin bot injects (telegram-penguin/src/memory.ts)."""
    done = [c for c in read_jsonl(CASES, 200) if c.get("outcome") != "pending"]
    if not done:
        return None
    tally = {k: sum(c.get("outcome") == k for c in done) for k in ("won", "partial", "lost")}
    lines = []
    for c in reversed(done[-max_n:]):
        tag = {"won": "WON", "partial": "PARTIAL"}.get(c.get("outcome"), "LOST")
        summary = " ".join(str(c.get("summary", "")).split())[:160]
        note = " ".join(str(c.get("note", "")).split())[:200]
        lines.append(f"- [{tag}] {summary}" + (f' — user: "{note}"' if note else ""))
    return "\n".join([f"Lessons from past cases ({len(done)} recorded: {tally['won']} won, "
                      f"{tally['partial']} partial, {tally['lost']} lost). Prefer what won; warn about what lost.",
                      *lines])


def engine_info() -> dict:
    cases = read_jsonl(CASES)
    try:
        profile = json.loads(PROFILE_PATH.read_text())
    except (OSError, ValueError):
        profile = {}
    return {
        "profile": PROFILE_NAME,
        "profile_loaded": bool(profile.get("system_prompt")),
        "limits": profile.get("limits"),
        "harness_token": bool(env_value("HARNESS_TOKEN")),
        "turns": len(read_jsonl(TURNS)),
        "support_turns": sum(str(t.get("chat", "")).startswith("support-ui:") for t in read_jsonl(TURNS)),
        "cases": len(cases),
        "outcomes": {k: sum(c.get("outcome") == k for c in cases) for k in OUTCOMES},
        "lessons": lessons_block(),
        "domains": list(TRIAGE_DOMAINS),
        "objections": list(TRIAGE_OBJECTIONS),
    }


def profile_prompt() -> str:
    try:
        return json.loads(PROFILE_PATH.read_text()).get("system_prompt") or ""
    except (OSError, ValueError):
        return ""


def run_triage(messages: list[dict]) -> dict:
    """One Jev request: domain, objection and whether the key facts are present."""
    global _jev_skip
    convo = "\n".join(f"{'User' if m['role'] == 'user' else 'Advocate'}: {m['content'][:600]}"
                      for m in messages[-6:])
    body = {"model": BACKENDS["jev"]["model"], "state": convo, "questions": triage_questions()}
    with _state_lock:
        _jev_skip += 1
    t0 = time.time()
    try:
        req = urllib.request.Request(f"{BACKENDS['jev']['base']}/v1/systemone", json.dumps(body).encode(),
                                     {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=90) as r:
            resp = json.load(r)
    except Exception:
        with _state_lock:
            _jev_skip = max(0, _jev_skip - 1)
        raise
    el = time.time() - t0
    a = resp.get("answers") or {}
    pt = (resp.get("usage") or {}).get("input_tokens") or 0
    record_job("jev", {"timestamp_unix": time.time(), "endpoint": "/v1/systemone", "source": "chat",
                       "stream": False, "finish_reason": "200", "prompt_tokens": pt, "completion_tokens": 0,
                       "ttft_s": el, "request_elapsed_s": el, "prefill_tok_s": pt / el if el else None})

    def top(q: str) -> dict:
        x = a.get(q) or {}
        probs = x.get("probabilities") or {}
        return {"choice": x.get("choice"), "p": probs.get(x.get("choice"), 0.0),
                "top3": sorted(probs.items(), key=lambda kv: -kv[1])[:3]}

    return {"domain": top("domain"), "objection": top("objection"),
            "has_facts": (a.get("has_facts") or {}).get("noul"), "elapsed_s": el, "prompt_tokens": pt}


# MLX records produced while an engine-mode chat is open are tagged `chat`: the
# harness makes several model calls per reply, so they can't be matched one by
# one. Other clients' requests in the same window get tagged too.
_chat_windows: list[list] = []


def chat_window_tag(rec: dict) -> str | None:
    ts = rec.get("timestamp_unix") or 0
    now = time.time()
    with _state_lock:
        _chat_windows[:] = [w for w in _chat_windows if w[1] is None or now - w[1] < 120]
        for start, end in _chat_windows:
            if start - 1 <= ts <= (end or now) + 3:
                return "chat"
    return None


def clean_session(s) -> str:
    s = "".join(ch for ch in str(s or "") if ch.isalnum() or ch in "-_")[:40]
    return s or f"s{int(time.time())}"


def clean_messages(raw) -> list[dict]:
    msgs = []
    for m in (raw or [])[-20:]:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str):
            msgs.append({"role": m["role"], "content": m["content"][:8000]})
    return msgs


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
        with self.__dict__.setdefault("_wlock", threading.Lock()):
            self.wfile.write(msg)
            self.wfile.flush()

    def do_POST(self):
        url = urlparse(self.path)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(n, 512 * 1024)) or b"{}") if n else {}
        except ValueError:
            self._json(400, {"error": "invalid JSON"})
            return
        if url.path == "/api/chat":
            self.chat(body)
        elif url.path == "/api/chat/outcome":
            self.outcome(body)
        else:
            self.send_response(404)
            self.end_headers()

    def outcome(self, body: dict) -> None:
        outcome = str(body.get("outcome") or "").lower()
        if outcome not in OUTCOMES:
            self._json(400, {"error": f"outcome must be one of {', '.join(OUTCOMES)}"})
            return
        append_jsonl(CASES, {"ts": now_iso(), "chat": f"support-ui:{clean_session(body.get('session'))}",
                             "outcome": outcome, "note": str(body.get("note") or "")[:500],
                             "summary": str(body.get("summary") or "(support chat)")[:300],
                             "source": "support-ui"})
        self._json(200, engine_info())

    def chat(self, body: dict) -> None:
        session = clean_session(body.get("session"))
        messages = clean_messages(body.get("messages"))
        mode = "quick" if body.get("mode") == "quick" else "engine"
        backend = body.get("backend") if body.get("backend") in ("qwen35", "qwen25") else "qwen35"
        self._sse_headers()
        if not messages or messages[-1]["role"] != "user":
            self._write(sse("fail", {"error": "last message must be from the user"}))
            return
        chat_id = f"support-ui:{session}"
        append_jsonl(TURNS, {"ts": now_iso(), "chat": chat_id, "role": "user",
                             "content": messages[-1]["content"], "source": "support-ui", "mode": mode})

        triage: dict = {}

        def do_triage():
            try:
                triage.update(run_triage(messages))
                self._write(sse("triage", triage))
            except Exception as e:
                try:
                    self._write(sse("triage", {"error": str(e)}))
                except OSError:
                    pass

        tri = threading.Thread(target=do_triage, daemon=True)
        tri.start()
        t0 = time.time()
        try:
            if mode == "engine" and not env_value("HARNESS_TOKEN"):
                self._write(sse("status", {"phase": "no HARNESS_TOKEN in services/.env; using quick mode"}))
                mode = "quick"
            if mode == "engine":
                reply = self._chat_engine(messages, t0)
            else:
                reply = self._chat_quick(backend, messages)
            tri.join(timeout=90)
            reply.update(mode=mode, elapsed_s=time.time() - t0, triage=triage or None)
            append_jsonl(TURNS, {"ts": now_iso(), "chat": chat_id, "role": "assistant", "content": reply["text"],
                                 "model": reply.get("model"), "tool_calls": reply.get("tool_calls", 0),
                                 "source": "support-ui", "mode": mode, "triage": triage or None})
            self._write(sse("reply", reply))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                self._write(sse("fail", {"error": str(e)}))
            except OSError:
                pass

    def _chat_engine(self, messages: list[dict], t0: float) -> dict:
        lessons = lessons_block()
        msgs = ([{"role": "system", "content": lessons}] if lessons else []) + messages
        # Tighter than the profile (callers may only tighten): each harness round
        # re-reads a 4-7k token prompt, and compute aborts any single model call
        # after 300 s, so long answers under contention never finish.
        body = json.dumps({"model": "qwen", "profile": PROFILE_NAME, "messages": msgs, "max_tokens": 700,
                           "limits": {"max_tool_rounds": 2}}).encode()
        req = urllib.request.Request(f"{COMPUTE}/v1/agent/completions", body, {
            "Content-Type": "application/json", "x-harness-token": env_value("HARNESS_TOKEN") or ""})
        result: dict = {}

        def call():
            try:
                with urllib.request.urlopen(req, timeout=600) as r:
                    result["resp"] = json.load(r)
            except urllib.error.HTTPError as e:
                result["error"] = f"compute HTTP {e.code}: {e.read()[:300].decode('utf-8', 'replace')}"
            except Exception as e:
                result["error"] = str(e)

        window = [time.time(), None]
        with _state_lock:
            _chat_windows.append(window)
        th = threading.Thread(target=call, daemon=True)
        th.start()
        try:
            while th.is_alive():
                th.join(timeout=2)
                if th.is_alive():
                    self._write(sse("status", {"phase": "engine", "elapsed_s": time.time() - t0}))
        finally:
            window[1] = time.time()
        if "error" in result:
            raise RuntimeError(result["error"])
        resp = result["resp"]
        h = resp.get("harness") or {}
        text = (((resp.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
        return {"text": text or "(empty reply)", "model": resp.get("model") or "qwen",
                "tool_calls": h.get("tool_calls", 0), "harness": {k: h.get(k) for k in (
                    "profile", "backend", "tool_calls", "tools_used", "rounds", "stopped_by", "elapsed_ms")},
                "lessons": bool(lessons)}

    def _chat_quick(self, backend: str, messages: list[dict]) -> dict:
        lessons = lessons_block()
        system = "\n\n".join(x for x in (profile_prompt(), lessons,
                                         "Web search is unavailable in this mode; say when a fact needs checking.") if x)
        if not _probe_locks[backend].acquire(blocking=False):
            raise RuntimeError("a probe or quick chat is already streaming on this backend")
        try:
            text = self._stream_messages(backend, [{"role": "system", "content": system}, *messages], 900, "chat")
        finally:
            broadcast("live", set_live(backend, active=False, inst_tok_s=0.0))
            _probe_locks[backend].release()
        return {"text": text.strip() or "(empty reply)", "model": BACKENDS[backend]["label"], "tool_calls": 0,
                "lessons": bool(lessons)}

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
        elif url.path == "/api/chat/engine":
            self._json(200, engine_info())
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
                self._jev_probe(prompt, max_tokens)
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
        self._stream_messages(backend, [{"role": "user", "content": prompt}], max_tokens, "probe")

    def _stream_messages(self, backend: str, messages: list[dict], max_tokens: int, source: str) -> str:
        """Stream a completion as `token` events + `done`; returns the answer text (no reasoning)."""
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
            "messages": messages,
        }).encode()
        answer: list[str] = []
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
                text, reasoning = "", ""
                for ch in d.get("choices") or []:
                    delta = ch.get("delta") or {}
                    text += delta.get("content") or ""
                    reasoning += delta.get("reasoning_content") or delta.get("reasoning") or ""
                    finish = ch.get("finish_reason") or finish
                answer.append(text)
                if not text and not reasoning:
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
                self._write(sse("token", {"text": text, "reasoning": reasoning, **state}))
                if now - last_push >= 0.2:
                    broadcast("live", state)
                    last_push = now

        final = set_live(backend)
        if cfg["kind"] == "mlx":
            expect_mlx(usage, source)
        else:
            usage = usage or {}
            ttft = final.get("ttft_s")
            record_job(backend, {
                "timestamp_unix": time.time(), "endpoint": "/v1/chat/completions", "source": source,
                "stream": True, "model": model, "finish_reason": finish or "stop",
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens") or final["tokens"],
                "ttft_s": ttft, "request_elapsed_s": time.time() - t0,
                "decode_tok_s": final["tok_s"] or None,
                "prefill_tok_s": (usage.get("prompt_tokens") or 0) / ttft if ttft else None,
            })
        self._write(sse("done", {**final, "usage": usage, "mlx_tok_s": server_rate}))
        return "".join(answer)

    def _jev_probe(self, prompt: str, max_tokens: int) -> None:
        cfg = BACKENDS["jev"]
        global _jev_skip
        with _state_lock:
            _jev_skip += 1
        t0 = time.time()
        broadcast("live", set_live("jev", active=True, tokens=0, tok_s=0.0, inst_tok_s=0.0, ttft_s=None, elapsed_s=0.0))
        self._write(sse("start", {"backend": "jev", "model": cfg["model"]}))
        j = jev_job(prompt, max_tokens)
        el = time.time() - t0
        usage = j["usage"]
        resp = {"answers": j["answers"]}
        pt = usage.get("input_tokens") or 0
        state = set_live("jev", tokens=pt, ttft_s=el, elapsed_s=el,
                         tok_s=pt / j["judge_s"] if j["judge_s"] else 0.0, inst_tok_s=0.0)
        self._write(sse("token", {"text": f"{j['text']}\n\n-- jev verdict ({j['judge_s']:.2f}s, "
                                          f"response by {BACKENDS[JEV_GENERATOR]['label']} in {j['gen_s']:.1f}s):\n"
                                          + "\n".join(j["lines"]), **state}))
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
