"""Job handlers: `kind` -> function(payload, ctx) -> JSON-serializable result.

Handlers run in a fresh spawned process per job, so they may hold browsers,
event loops, GPU contexts, etc. without leaking state into the next job.
Raise `Permanent` for errors that retrying can't fix (bad input); any other
exception or a hard crash is retried up to the job's max_attempts, resuming
from the last `ctx.checkpoint(...)`.
"""
import json
import os
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable


class Permanent(Exception):
    """Fail the job now; don't retry."""


@dataclass
class Context:
    job_id: str
    attempt: int
    resume: Any  # last saved checkpoint, None on a fresh start
    _save: Callable[[Any], bool] = field(repr=False)
    _progress: Callable[[Any], bool] = field(repr=False, default=lambda _state: True)

    def checkpoint(self, state: Any) -> None:
        if not self._save(state):
            # The job is no longer ours (lease lost / cancelled): stop working.
            raise SystemExit(0)

    def progress(self, state: Any) -> None:
        """Publish live progress (shown to clients via GET /v1/jobs/<id>)."""
        self._progress(state)


Handler = Callable[[Any, Context], Any]
REGISTRY: dict[str, Handler] = {}


def handler(kind: str) -> Callable[[Handler], Handler]:
    def register(fn: Handler) -> Handler:
        REGISTRY[kind] = fn
        return fn
    return register


@handler("echo")
def echo(payload: Any, ctx: Context) -> Any:
    return {"echo": payload, "attempt": ctx.attempt}


@handler("sleep")
def sleep(payload: dict, ctx: Context) -> Any:
    """Counts to `seconds`, checkpointing each step — resumes mid-way on retry.
    `crash_at` hard-kills the process at that step on the first attempt (for
    exercising crash recovery)."""
    seconds = int(payload.get("seconds", 3))
    crash_at = payload.get("crash_at")
    start = (ctx.resume or {}).get("done", 0)
    for i in range(start, seconds):
        if crash_at is not None and i == crash_at and ctx.attempt == 1:
            os._exit(137)  # like an OOM kill: no finally, no result sent
        time.sleep(1)
        ctx.checkpoint({"done": i + 1})
    return {"slept": seconds, "resumed_from": start, "attempt": ctx.attempt}


@handler("fail")
def fail(payload: dict, ctx: Context) -> Any:
    if payload.get("permanent"):
        raise Permanent(payload.get("message", "permanent failure"))
    raise RuntimeError(payload.get("message", "transient failure"))


def _chat(payload: dict, body: dict) -> dict:
    """POST one chat completion to an OpenAI-compatible server."""
    base_url = (payload.get("base_url") or os.environ.get("LLM_BASE_URL") or "http://localhost:11434/v1").rstrip("/")
    headers = {"Content-Type": "application/json"}
    if os.environ.get("LLM_API_KEY"):
        headers["Authorization"] = f"Bearer {os.environ['LLM_API_KEY']}"
    req = urllib.request.Request(f"{base_url}/chat/completions", json.dumps(body).encode(), headers)
    try:
        with urllib.request.urlopen(req, timeout=float(payload.get("http_timeout_s", 300))) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        if 400 <= e.code < 500 and e.code not in (408, 429):
            raise Permanent(f"HTTP {e.code}: {detail}") from e
        raise RuntimeError(f"HTTP {e.code}: {detail}") from e


def _chat_stream(payload: dict, body: dict, on_delta: Callable[[str, str], None]) -> dict:
    """Streaming chat completion. Calls on_delta("reasoning"|"content", text)
    as tokens arrive and returns the assembled message plus timing/usage:
    {"content", "reasoning", "tool_calls", "usage", "ttft_s", "gen_s"}."""
    base_url = (payload.get("base_url") or os.environ.get("LLM_BASE_URL") or "http://localhost:11434/v1").rstrip("/")
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if os.environ.get("LLM_API_KEY"):
        headers["Authorization"] = f"Bearer {os.environ['LLM_API_KEY']}"
    body = {**body, "stream": True, "stream_options": {"include_usage": True}}
    req = urllib.request.Request(f"{base_url}/chat/completions", json.dumps(body).encode(), headers)
    out = {"content": "", "reasoning": "", "usage": {}, "ttft_s": None}
    calls: dict[int, dict] = {}
    started = time.time()
    first = None
    chunks = 0
    try:
        res = urllib.request.urlopen(req, timeout=float(payload.get("http_timeout_s", 300)))
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        if 400 <= e.code < 500 and e.code not in (408, 429):
            raise Permanent(f"HTTP {e.code}: {detail}") from e
        raise RuntimeError(f"HTTP {e.code}: {detail}") from e
    with res:
        for raw in res:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            chunk = json.loads(data)
            if chunk.get("usage"):
                out["usage"] = chunk["usage"]
            for choice in chunk.get("choices") or []:
                delta = choice.get("delta") or {}
                for field_name, kind in (("reasoning", "reasoning"), ("reasoning_content", "reasoning"),
                                         ("content", "content")):
                    text = delta.get(field_name)
                    if text:
                        if first is None:
                            first = time.time()
                        chunks += 1
                        out[kind] += text
                        on_delta(kind, text)
                for tc in delta.get("tool_calls") or []:
                    if first is None:
                        first = time.time()
                    slot = calls.setdefault(tc.get("index", len(calls)), {
                        "id": tc.get("id") or f"call-{len(calls)}", "type": "function",
                        "function": {"name": "", "arguments": ""}})
                    fn = tc.get("function") or {}
                    slot["function"]["name"] += fn.get("name") or ""
                    args = fn.get("arguments")
                    slot["function"]["arguments"] += args if isinstance(args, str) else json.dumps(args or {})
    end = time.time()
    out["tool_calls"] = [calls[i] for i in sorted(calls)]
    out["ttft_s"] = round(first - started, 3) if first else None
    out["gen_s"] = round(end - (first or started), 3)
    if not out["usage"]:  # server didn't report usage: approximate 1 chunk ≈ 1 token
        out["usage"] = {"prompt_tokens": None, "completion_tokens": chunks, "estimated": True}
    return out


def _messages(payload: dict) -> list[dict]:
    messages = payload.get("messages") or [{"role": "user", "content": payload.get("prompt") or ""}]
    if not any(m.get("content") for m in messages):
        raise Permanent("payload needs `prompt` or `messages`")
    return messages


@handler("llm")
def llm(payload: dict, ctx: Context) -> Any:
    """Chat completion against any OpenAI-compatible server — Ollama, vLLM,
    llama.cpp, LM Studio (e.g. qwen on a local GPU) or a hosted API.

    payload: {"prompt": str} or {"messages": [...]}, optional "model",
    "base_url", "max_tokens", "temperature". Defaults from LLM_BASE_URL /
    LLM_MODEL / LLM_API_KEY."""
    model = payload.get("model") or os.environ.get("LLM_MODEL") or "qwen2.5:1.5b"
    body = {"model": model, "messages": _messages(payload)}
    for k in ("max_tokens", "temperature"):
        if k in payload:
            body[k] = payload[k]
    started = time.time()
    data = _chat(payload, body)
    elapsed = time.time() - started
    usage = data.get("usage") or {}
    out_tokens = usage.get("completion_tokens")
    return {
        "model": data.get("model", model),
        "text": data["choices"][0]["message"]["content"],
        "usage": usage,
        "elapsed_s": round(elapsed, 3),
        "tokens_per_s": round(out_tokens / elapsed, 1) if out_tokens and elapsed else None,
    }


AGENT_SYSTEM = (
    "You are an assistant running on the user's own computer with tools for web search, fetching web pages, "
    "and READ-ONLY access to the local filesystem (list_dir, read_file, find_files). Use tools whenever the "
    "question needs current information or file contents; never invent file contents or URLs. "
    "Paths can start with ~ for the home directory. Keep final answers concise."
)


def _text_tool_calls(content: str, known: dict) -> list[dict]:
    """Some local models (e.g. qwen2.5-coder in Ollama) write tool calls as
    JSON in the message text instead of `tool_calls`. Recover those: each
    {"name": <known tool>, "arguments": {...}} object, bare, fenced or in
    <tool_call> tags."""
    calls = []
    decoder = json.JSONDecoder()
    i = content.find("{")
    while i != -1:
        try:
            obj, end = decoder.raw_decode(content, i)
        except json.JSONDecodeError:
            i = content.find("{", i + 1)
            continue
        if isinstance(obj, dict) and obj.get("name") in known:
            args = obj.get("arguments", obj.get("parameters", {}))
            if isinstance(args, str):  # some models double-encode arguments
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    pass
            calls.append({"id": f"text-{len(calls)}", "type": "function",
                          "function": {"name": obj["name"], "arguments": json.dumps(args)}})
        i = content.find("{", end)
    return calls


@handler("agent")
def agent(payload: dict, ctx: Context) -> Any:
    """`llm` plus thinking and a tool loop. Streams the model's reasoning and
    each tool call into ctx.progress so clients can show the chain live, then
    returns the answer with the full chain and throughput metrics.

    The model may call web_search / fetch_url / list_dir / read_file /
    find_files (tools.py) for up to `max_steps` rounds. Thinking models
    (qwen3, deepseek-r1, …) reason by default; payload "think": false turns it
    off. Model from payload / AGENT_MODEL / LLM_MODEL."""
    from . import tools

    model = payload.get("model") or os.environ.get("AGENT_MODEL") or os.environ.get("LLM_MODEL") or "qwen2.5:1.5b"
    messages = _messages(payload)
    if messages[0].get("role") != "system":
        messages = [{"role": "system", "content": AGENT_SYSTEM}, *messages]
    else:
        messages = [{"role": "system", "content": AGENT_SYSTEM + "\n\n" + messages[0]["content"]}, *messages[1:]]
    schemas = [schema for _, schema in tools.TOOLS.values()]
    extra = {"reasoning_effort": "none"} if payload.get("think") is False else {}

    chain: list[dict] = []  # [{"type": "thinking", "text"} | {"type": "tool", "tool", "args", "result_preview"}]
    state = {"phase": "thinking", "step": 0, "chain": chain, "live": ""}
    last_push = [0.0]

    def push(force: bool = False) -> None:
        now = time.time()
        if force or now - last_push[0] >= 0.75:
            ctx.progress({**state, "chain": chain[-12:], "live": state["live"][-1500:]})
            last_push[0] = now

    def on_delta(kind: str, text: str) -> None:
        if kind == "reasoning":
            state["phase"] = "thinking"
            state["live"] += text
        else:
            state["phase"] = "answering"
        push()

    totals = {"prompt_tokens": 0, "completion_tokens": 0}
    gen_s = 0.0
    ttft = None
    started = time.time()
    max_steps = int(payload.get("max_steps", 6))
    final = None
    for step in range(max_steps + 1):
        state.update(step=step + 1, live="", phase="thinking")
        push(force=True)
        last_round = step == max_steps
        if last_round:
            messages.append({"role": "user", "content": "Answer now using the tool results above; do not call more tools."})
        body = {"model": model, "messages": messages, **extra}
        if not last_round:
            body["tools"] = schemas
        res = _chat_stream(payload, body, on_delta)
        totals["prompt_tokens"] += res["usage"].get("prompt_tokens") or 0
        totals["completion_tokens"] += res["usage"].get("completion_tokens") or 0
        gen_s += res["gen_s"]
        ttft = ttft if ttft is not None else res["ttft_s"]
        if res["reasoning"].strip():
            chain.append({"type": "thinking", "step": step + 1, "text": res["reasoning"].strip()})
        calls = [] if last_round else (res["tool_calls"] or _text_tool_calls(res["content"], tools.TOOLS))
        if not calls:
            final = res["content"]
            break
        messages.append({"role": "assistant", "content": res["content"] or "", "tool_calls": calls})
        for call in calls:
            fn = call["function"]
            state.update(phase="tool", live=f"{fn['name']}({fn.get('arguments')})")
            push(force=True)
            out = tools.call(fn["name"], fn.get("arguments"))
            chain.append({"type": "tool", "step": step + 1, "tool": fn["name"], "args": fn.get("arguments"),
                          "ok": not out.startswith("error:"), "result_preview": out[:300]})
            messages.append({"role": "tool", "tool_call_id": call.get("id", ""), "name": fn["name"], "content": out})
    elapsed = time.time() - started
    state.update(phase="done", live="")
    push(force=True)
    return {
        "model": model,
        "text": (final or "").strip(),
        "chain": chain,
        "tool_calls": [c for c in chain if c["type"] == "tool"],
        "thinking": "\n\n".join(c["text"] for c in chain if c["type"] == "thinking")[-20000:],
        "usage": totals,
        "steps": state["step"],
        "elapsed_s": round(elapsed, 3),
        "ttft_s": ttft,
        "tokens_per_s": round(totals["completion_tokens"] / gen_s, 1) if gen_s and totals["completion_tokens"] else None,
    }
