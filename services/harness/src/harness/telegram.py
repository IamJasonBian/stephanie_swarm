"""Telegram bridge: long-polls the bot for messages, runs each one as an
`agent` (or `llm`) job through the harness HTTP API, and replies.

While the job runs the bot posts "🤔 Thinking…" and keeps editing it with
the live chain — the model's reasoning and each tool call — then replaces it
with the answer, the full chain folded into an expandable quote, and a
one-line throughput footer. /stats shows capacity metrics.

Long polling (getUpdates) needs no public URL, so this works from a laptop
behind NAT. It is just another API client — the dispatcher does the work.

Env: TELEGRAM_BOT_TOKEN (required), TELEGRAM_ALLOWED_CHAT_IDS (comma list;
empty = anyone who finds the bot can use it), HARNESS_URL, HARNESS_API_KEY,
TELEGRAM_HISTORY (turns of context kept per chat, default 6).
"""
import html
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from typing import Any

log = logging.getLogger("harness.telegram")

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
TG = f"https://api.telegram.org/bot{TOKEN}"
HARNESS = os.environ.get("HARNESS_URL", "http://127.0.0.1:8790").rstrip("/")
HARNESS_KEY = os.environ.get("HARNESS_API_KEY", "").strip()
ALLOWED = {int(c) for c in os.environ.get("TELEGRAM_ALLOWED_CHAT_IDS", "").replace(" ", "").split(",") if c}
HISTORY = int(os.environ.get("TELEGRAM_HISTORY", "6"))
# Tools (web + read-only filesystem) only when the bot is locked to known chats.
KIND = os.environ.get("TELEGRAM_KIND", "agent" if ALLOWED else "llm")
if KIND == "agent" and not ALLOWED:
    raise SystemExit("TELEGRAM_KIND=agent needs TELEGRAM_ALLOWED_CHAT_IDS (it exposes your filesystem)")
SYSTEM = os.environ.get("TELEGRAM_SYSTEM_PROMPT", "You are replying in a Telegram chat on a phone: be brief and plain.")
MAX_MESSAGE = 4096  # Telegram's limit per message
EDIT_EVERY_S = 1.5  # Telegram rate-limits edits; ~1/s per chat is safe

_history: dict[int, deque] = defaultdict(lambda: deque(maxlen=HISTORY * 2))
_lock = threading.Lock()


def _post(url: str, body: dict, headers: dict | None = None, timeout: float = 60) -> Any:
    req = urllib.request.Request(
        url, json.dumps(body).encode(), {"Content-Type": "application/json", **(headers or {})}
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read())


def _get(url: str, headers: dict | None = None, timeout: float = 60) -> Any:
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=timeout) as res:
        return json.loads(res.read())


def tg(method: str, **params: Any) -> Any:
    return _post(f"{TG}/{method}", params, timeout=params.get("timeout", 0) + 15)["result"]


def _auth() -> dict:
    return {"Authorization": f"Bearer {HARNESS_KEY}"} if HARNESS_KEY else {}


def run_job(messages: list[dict], key: str, on_progress=None) -> dict:
    """Submit a job and poll until it finishes, calling on_progress(progress)
    whenever the job publishes new progress. Returns the job's result."""
    job = _post(f"{HARNESS}/v1/jobs", {"kind": KIND, "key": key, "payload": {"messages": messages},
                                        "timeout_s": 300, "max_attempts": 2}, _auth())["job"]
    deadline = time.time() + 360
    seen = None
    while time.time() < deadline:
        job = _get(f"{HARNESS}/v1/jobs/{job['id']}?wait={1 if on_progress else 25}", _auth())["job"]
        if job["status"] == "succeeded":
            return job["result"]
        if job["status"] in ("failed", "cancelled"):
            raise RuntimeError(f"job {job['status']}: {(job['error'] or '').splitlines()[0][:200]}")
        if on_progress and job.get("progress") and job["progress"] != seen:
            seen = job["progress"]
            on_progress(seen)
    raise TimeoutError("no result after 360s")


def run_llm(messages: list[dict], key: str) -> str:
    return run_job(messages, key)["text"]


# ---- rendering (Telegram HTML) ---------------------------------------------

def _esc(s: str) -> str:
    return html.escape(s, quote=False)


def _tool_line(c: dict) -> str:
    args = c.get("args") or ""
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            pass
    if isinstance(args, dict):
        args = ", ".join(f"{v}" for v in args.values())
    return f"🔧 {c['tool']}({str(args)[:120]}){'' if c.get('ok', True) else ' ⚠️'}"


def render_progress(p: dict) -> str:
    lines = [f"🤔 <b>Thinking…</b> <i>step {p.get('step', 1)}</i>"]
    for c in p.get("chain", [])[-6:]:
        if c["type"] == "tool":
            lines.append(_esc(_tool_line(c)))
        else:
            lines.append(f"💭 <i>{_esc(c['text'][-160:].strip())}</i>")
    live = (p.get("live") or "").strip()
    if p.get("phase") == "tool":
        lines.append(f"⏳ {_esc(live[:200])}")
    elif p.get("phase") == "answering":
        lines.append("✍️ <i>writing answer…</i>")
    elif live:
        lines.append(f"<blockquote>{_esc(live[-700:])}</blockquote>")
    return "\n".join(lines)[:MAX_MESSAGE]


def render_final(result: dict) -> str:
    answer = _esc(result.get("text") or "(empty reply)")
    chain_lines = []
    for c in result.get("chain") or []:
        if c["type"] == "tool":
            chain_lines.append(_tool_line(c))
        else:
            t = c["text"].strip()
            chain_lines.append(f"💭 {t if len(t) <= 700 else '…' + t[-700:]}")
    u = result.get("usage") or {}
    footer = (f"<i>{result.get('model')} · {result.get('elapsed_s')}s · "
              f"{u.get('completion_tokens') or '?'} tok · {result.get('tokens_per_s') or '?'} tok/s"
              f"{' · ttft ' + str(result['ttft_s']) + 's' if result.get('ttft_s') else ''}</i>")
    chain = ""
    if chain_lines:
        budget = MAX_MESSAGE - len(answer) - len(footer) - 120
        text = "\n".join(chain_lines)
        if budget > 200:
            text = text if len(text) <= budget else "…" + text[-(budget - 1):]
            chain = f"<blockquote expandable>🧠 <b>Chain</b>\n{_esc(text)}</blockquote>\n"
    return f"{chain}{answer}\n\n{footer}"


def render_stats() -> str:
    m = _get(f"{HARNESS}/v1/metrics?window=3600", _auth())
    lines = ["📊 <b>Last hour</b>"]
    for g in m["throughput"]:
        lines.append(
            f"• <b>{_esc(g['kind'])}</b> {_esc(g['model'] or '')}: {g['jobs']} jobs "
            f"({g.get('failed', 0)} failed) · {g['tokens_per_s_avg'] or '?'} tok/s · "
            f"p50 {g['latency_p50_s']}s p95 {g['latency_p95_s']}s · wait p95 {g['queue_wait_p95_s']}s · "
            f"{g['completion_tokens']} out tok")
    if not m["throughput"]:
        lines.append("• no jobs")
    for s in m["machines"]:
        models = ", ".join(f"{x['model']} {x['vram_gb']}GB" for x in (s.get("models_loaded") or [])) or "none"
        batt = f" · 🔋 {s['battery_pct']:.0f}%{'⚡' if s['on_ac_power'] else ''}" if s.get("battery_pct") is not None else ""
        lines += [
            f"\n💻 <b>{_esc(s['worker'])}</b> <i>({s['age_s']:.0f}s ago)</i>",
            f"CPU {s['cpu_pct']:.0f}% · load {s['load_1m']} · RAM {s['mem_used_gb']}/{s['mem_total_gb']}GB "
            f"({s['mem_pct']:.0f}%) · swap {s['swap_used_gb']}GB{batt}",
            f"Models: {_esc(models)}",
            f"Jobs: {s['running_jobs']} running, {s['queued_jobs']} queued",
        ]
    return "\n".join(lines)


def _edit(chat_id: int, message_id: int, text: str) -> None:
    try:
        tg("editMessageText", chat_id=chat_id, message_id=message_id, text=text, parse_mode="HTML")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        if "message is not modified" not in detail:
            log.warning("edit failed: %s", detail[:200])


def handle(msg: dict) -> None:
    chat_id = msg["chat"]["id"]
    text = (msg.get("text") or "").strip()
    who = msg.get("from", {}).get("username") or msg.get("from", {}).get("first_name")
    if ALLOWED and chat_id not in ALLOWED:
        log.warning("ignored message from chat %s (@%s): not in TELEGRAM_ALLOWED_CHAT_IDS", chat_id, who)
        return
    if not text:
        return
    log.info("chat %s (@%s): %s", chat_id, who, text[:80])
    if text in ("/start", "/help"):
        tg("sendMessage", chat_id=chat_id,
           text="Connected to the local harness. Send any message; /stats shows capacity, /reset clears context.")
        return
    if text == "/reset":
        with _lock:
            _history.pop(chat_id, None)
        tg("sendMessage", chat_id=chat_id, text="Context cleared.")
        return
    if text == "/stats":
        tg("sendMessage", chat_id=chat_id, text=render_stats(), parse_mode="HTML")
        return

    placeholder = tg("sendMessage", chat_id=chat_id, text="🤔 <b>Thinking…</b>", parse_mode="HTML",
                     reply_parameters={"message_id": msg["message_id"]})["message_id"]
    last_edit = [time.time()]

    def on_progress(p: dict) -> None:
        if time.time() - last_edit[0] >= EDIT_EVERY_S:
            _edit(chat_id, placeholder, render_progress(p))
            last_edit[0] = time.time()

    with _lock:
        turns = list(_history[chat_id])
    messages = [{"role": "system", "content": SYSTEM}, *turns, {"role": "user", "content": text}]
    try:
        result = run_job(messages, key=f"tg:{chat_id}:{msg['message_id']}", on_progress=on_progress)
        with _lock:
            _history[chat_id].extend([{"role": "user", "content": text},
                                      {"role": "assistant", "content": result.get("text") or ""}])
        final = render_final(result)
        if len(final) <= MAX_MESSAGE:
            _edit(chat_id, placeholder, final)
        else:  # very long answer: plain text in chunks
            reply = result.get("text") or ""
            _edit(chat_id, placeholder, _esc(reply[:MAX_MESSAGE - 100]))
            for i in range(MAX_MESSAGE - 100, len(reply), MAX_MESSAGE):
                tg("sendMessage", chat_id=chat_id, text=reply[i:i + MAX_MESSAGE])
    except Exception as e:
        log.error("chat %s: %s", chat_id, e)
        _edit(chat_id, placeholder, f"⚠️ harness error: {_esc(str(e))}")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if not TOKEN:
        raise SystemExit("TELEGRAM_BOT_TOKEN is not set (put it in harness/.env)")
    me = tg("getMe")
    log.info("bridge up as @%s -> %s kind=%s (allowed chats: %s)", me["username"], HARNESS, KIND,
             sorted(ALLOWED) or "anyone")
    offset = None
    while True:
        try:
            updates = tg("getUpdates", timeout=30, offset=offset, allowed_updates=["message"])
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            log.warning("getUpdates failed (%s); retrying in 5s", e)
            time.sleep(5)
            continue
        for u in updates:
            offset = u["update_id"] + 1
            if "message" in u:
                # One thread per message so a slow model reply doesn't stall polling.
                threading.Thread(target=handle, args=(u["message"],), daemon=True).start()


if __name__ == "__main__":
    main()
