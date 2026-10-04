# harness

Port: **:8790** (alongside dispatch :8877 / compute :8878).

Generic job service: clients submit work, get a job id (token) back at once,
and poll / long-poll for the result. A dispatcher runs every job in its own
spawned process with per-job timeout, cancel, retry and checkpoint-resume.

```
iphone / web / android ──POST /v1/jobs──▶ API (gunicorn, stateless)
        ▲                                   │ insert row
        └──GET /v1/jobs/<id>?wait=15──      ▼
                                      SQLite jobs table  ◀── claim / heartbeat ──  dispatcher (1 per machine)
                                                                                    └─ spawn 1 process per job
                                                                                       ├─ llm  → Ollama/vLLM/qwen/OpenAI-compatible
                                                                                       ├─ sleep / echo / fail (testing)
                                                                                       └─ your handler (browser, scraper, …)
```

## Run

```bash
./dev.sh                       # API on :8790 + one dispatcher
uv run pytest                  # dispatcher behaviour tests

curl -XPOST localhost:8790/v1/jobs -H 'content-type: application/json' \
  -d '{"kind":"llm","payload":{"prompt":"hi","model":"qwen2.5:1.5b"}}'
curl 'localhost:8790/v1/jobs/<id>?wait=15'
```

Env (put local values in `.env`, which `dev.sh` loads and git ignores):
`HARNESS_DB`, `HARNESS_PORT`, `HARNESS_API_KEY` (bearer auth; off when
empty), `HARNESS_MAX_WORKERS`, `HARNESS_LEASE_S`, `HARNESS_HEARTBEAT_S`,
`HARNESS_SHUTDOWN_GRACE_S`, `HARNESS_SAMPLE_S`, `HARNESS_FS_ROOTS`,
`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `AGENT_MODEL`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`.

Ollama tips: `OLLAMA_KEEP_ALIVE=-1` keeps models resident (no cold loads);
`ollama pull qwen3:8b` for thinking + tools.

## Job kinds

| kind | what it does |
| --- | --- |
| `llm` | one chat completion against any OpenAI-compatible server (`LLM_BASE_URL`, default Ollama) |
| `agent` | thinking + tool loop: streams reasoning and tool calls into live `progress`, returns answer + `chain` + throughput |
| `echo` / `sleep` / `fail` | testing (`sleep` checkpoints and can hard-crash to exercise recovery) |

`agent` tools (`tools.py`): `web_search` (DuckDuckGo), `fetch_url` (public
hosts only), and **read-only** `list_dir` / `read_file` / `find_files` confined
to `HARNESS_FS_ROOTS` (default `$HOME`) with secret paths (`.ssh`, `.env`,
keys, keychains, …) blocked. Thinking models (`qwen3:8b`) reason by default;
`"think": false` in the payload turns it off.

Sampling and verbosity: `AGENT_TEMPERATURE` / `AGENT_TOP_P` (defaults in
`.env.example`: 1.0 / 0.95 — more varied than the model default) and
`LLM_TEMPERATURE` / `LLM_TOP_P`; a job's payload `temperature` / `top_p`
overrides them. Final answers are held to ≤3 short sentences or ≤5 bullets by
`AGENT_ANSWER_STYLE` (set it empty for no limit, or per job via
`"answer_style"`).

While a job runs, `GET /v1/jobs/<id>` includes `progress`
(`{"phase": "thinking|tool|answering|done", "step", "live", "chain"}`).

## Telegram bot

`harness-telegram` (started by `dev.sh` when `TELEGRAM_BOT_TOKEN` is in
`.env`) long-polls the bot — no public URL needed. Each message becomes an
`agent` job; the bot replies "🤔 Thinking…" and edits it live with the
reasoning and tool calls, then shows the answer with the full chain in an
expandable quote and a throughput footer. `/stats` shows capacity, `/reset`
clears context. Tools are only enabled when `TELEGRAM_ALLOWED_CHAT_IDS` is set.

## Capacity metrics

Each dispatcher samples the machine every `HARNESS_SAMPLE_S` (15s): CPU %,
load, RAM, swap, battery / AC, Ollama-resident models and their memory, and
running / queued jobs. Samples go to the `samples` table (7-day retention) and
a `capacity:` log line. Per-job throughput comes from job results.

```bash
curl 'localhost:8790/v1/metrics?window=3600'      # per kind+model: jobs, tok/s, ttft, p50/p95 latency, queue wait, tokens/min + latest sample per machine
curl 'localhost:8790/v1/metrics/samples?since=600' # raw samples
grep capacity: data.log                            # one line per sample
```

## Adding a job kind

```python
@handler("scrape")
def scrape(payload, ctx):
    for i, url in enumerate(payload["urls"][(ctx.resume or 0):], start=ctx.resume or 0):
        ...
        ctx.checkpoint(i + 1)          # retry resumes here after a crash
    return {...}                       # raise Permanent(...) to fail without retry
```

## Process model vs. the amazon server.py

| amazon server.py | harness |
| --- | --- |
| ProcessPoolExecutor per gunicorn worker, `max_tasks_per_child=1` | dispatcher owns one `Process` per job: same isolation, plus kill on timeout/cancel |
| one child death → whole pool `BrokenProcessPool`, siblings fail, pool rebuilt | a crash affects only that job |
| concurrency cap checked in SQLite but each gunicorn worker has its own pool | one dispatcher enforces `max_workers`; API workers never run jobs |
| queue table + master thread POSTing to itself (delete-then-send can drop a task) | `jobs` table is the queue; atomic `UPDATE … RETURNING` claim |
| startup reset of all `processing` rows + fixed stuck timeout | lease + heartbeat: only silent owners' jobs are recovered; safe with N dispatchers |
| done-callback on executor thread, locks around global pool | single-threaded loop, no callbacks, no locks |
| `last_processed_invoice` / `last_processed_stage` resume | generic `ctx.checkpoint(state)` → `ctx.resume` |
| per-brand `processing` duplicate guard (409) | optional `key`: one active job per key (returns the existing job) |

## Next steps (not built)

- Multi-machine (the "x100 MacBooks" box): swap SQLite for Postgres
  (`FOR UPDATE SKIP LOCKED` claim); dispatchers then run anywhere.
- Route by capability: tag dispatchers (`gpu`, `chrome`) and jobs, claim only matching.
- Push instead of poll: SSE/webhook on completion; streaming tokens for `llm`.
