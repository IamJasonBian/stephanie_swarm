# services — job dispatch + general-purpose compute

Two local HTTP services that give the UI and the Telegram bots a shared LLM
source with four model options (**hermes** — free/local via Ollama, **qwen** —
free/local via MLX, **claude** — Anthropic, **kimi** — Moonshot Kimi K2.6 via
OpenRouter), an opt-in **harness** route that lets tool-capable models run a
bounded MCP tool loop server-side, plus a Judge0 code-execution route that
activates once Judge0 CE is running in Docker.

```
UI / Telegram ──▶ dispatch :8877 (queue + broker) ──▶ compute :8878 ──▶ Ollama :11434 (hermes3:8b)
                                                                    ├──▶ MLX :8321 (qwen — Qwen3.5-27B-6bit, loopback only)
                                                                    ├──▶ Anthropic API / claude CLI
                                                                    ├──▶ OpenRouter (kimi-k2.6, free tier by default)
                                                                    ├──▶ harness ──▶ MCP servers (web-search, …)
                                                                    ├──▶ converter/ (docling, PDF/DOCX/image → markdown)
                                                                    └──▶ Judge0 CE :2358 (when configured)
```

Design note: a **backend** answers one model call; the **harness** may call the
backend repeatedly, execute allowlisted MCP tools, and feed results back. Plain
`/v1/chat/completions` never executes tools — tool use is a separate, token-gated
route. Full rationale and roadmap: `docs/local-harness-integration-plan.md`.

Clients that don't need queueing can hit the compute service directly — its
chat route is OpenAI-compatible, so any standard OpenAI client works by
pointing its base URL at `http://localhost:8878/v1`.

## Run

Node 25 runs the TypeScript directly — no build step.

```bash
cd services/compute  && npm install && node src/index.ts   # :8878
cd services/dispatch && npm install && node src/index.ts   # :8877
```

Prereqs: `ollama pull hermes3:8b` (done once), and for the claude option either
`ANTHROPIC_API_KEY` in the compute service's env or `CLAUDE_BACKEND=cli`
(spawns `claude -p`, reusing the machine's Claude subscription auth).

Document conversion (one-time setup — docling needs Python ≤3.13):

```bash
cd services/converter
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python docling
```

## Compute service (`:8878`)

### `POST /v1/chat/completions` — OpenAI-compatible chat

`model` takes an alias: `"hermes"`, `"qwen"`, `"claude"`, or `"kimi"`.
Non-streaming only (v1). OpenAI `tools` / `tool_choice` and
`tool_calls` / `role:"tool"` messages pass through to tool-capable backends
(`qwen`, `kimi`) — the route returns tool calls but does not execute them.

| Alias | Backing model | Cost |
|---|---|---|
| `hermes` | `hermes3:8b` local via Ollama | free (local compute) |
| `qwen` | `mlx-community/Qwen3.5-27B-6bit` local via `mlx_vlm.server` (Apple Silicon, ~21 GB, tool calling) — see `mlx/README.md` | free (local compute) |
| `claude` | `claude-sonnet-5` via Anthropic API or `claude -p` CLI | API $3/$15 per MTok, or subscription via CLI |
| `kimi` | `moonshotai/kimi-k2.6:free` via OpenRouter (1T-param MoE, 262K ctx) | free tier (rate-limited); paid `moonshotai/kimi-k2.6` ≈ $0.6/$3.4 per MTok. Too large to self-host. |

```bash
curl -s localhost:8878/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "hermes",
  "messages": [{"role": "user", "content": "say hi in five words"}]
}'
```

Response is a standard chat-completion object (`choices[0].message.content`,
`usage`, `finish_reason`). System messages in the array are handled correctly
for both backends. `GET /v1/models` lists the two aliases.

**Base system prompt:** every chat request gets a base system message injected
first — by default `prompts/negotiation.md`, a playbook of 25 negotiation
tactics (Harvard PON / Fisher & Ury, Chris Voss, Cialdini) covering
preparation (BATNA, ZOPA, accusation audit), anchoring, calibrated questions,
mirroring/labeling, value creation (logrolling, MESOs), influence principles,
and defenses against hard-bargaining tricks. The model applies them when a
conversation involves negotiating and answers normally otherwise.
Client-supplied system messages stack on top. Point `BASE_PROMPT_FILE` at a
different file to swap the persona, or set `BASE_PROMPT_FILE=""` to disable.
`GET /health` reports which base prompt is loaded.

**Document attachments:** add a `documents` array to the body and each item is
converted to markdown (docling) and prepended as reference context before the
conversation reaches the model:

```json
{
  "model": "hermes",
  "documents": [
    {"source": "https://example.com/report.pdf"},
    {"filename": "notes.docx", "data": "<base64>"}
  ],
  "messages": [{"role": "user", "content": "Summarize the attached report."}]
}
```

### `POST /v1/agent/completions` — bounded MCP tool loop (harness)

Explicit opt-in for server-side tool execution. Requires header
`x-harness-token: $HARNESS_TOKEN` (503 if the node has no token, 403 if it
doesn't match) and a `profile` from `config/harnesses/*.json`:

```bash
curl -s localhost:8878/v1/agent/completions -H 'Content-Type: application/json' \
  -H "x-harness-token: $HARNESS_TOKEN" -d '{
  "model": "qwen", "profile": "web-readonly",
  "messages": [{"role": "user", "content": "What is the current Node.js LTS? Cite the URL."}]
}'
```

Response is a chat-completion object plus `harness: {request_id, profile,
backend, tool_calls, rounds, elapsed_ms, stopped_by, tools_used}`. The loop
ends on the first of: final text answer · `max_tool_rounds` · wall-clock
`timeout_ms` · an identical repeated call · total tool-output budget. When a
limit trips, one last call is made with tools disabled so the caller always
gets an answer. Per request the caller may *tighten* limits (`limits: {...}`)
but never exceed the profile's.

A **profile** declares: which MCP servers to spawn (stdio; only declared env
vars reach the subprocess), a tool allowlist with `mutating` flags (mutating
tools are refused in v1 — no confirmation channel yet), per-tool timeouts and
output caps, allowed backends, and a system prompt. Paths use `${REPO_DIR}` /
`${HOME}`. Unknown profile / server / tool ⇒ refused. `GET /v1/harness/profiles`
lists what this node can run. Every tool call and denial is logged as one JSON
line (request id, tool, duration, bytes, outcome — never arguments).

Shipped profile: **`web-readonly`** — `web_search` via
`mcp-servers/web-search` (build its venv with `mcp-servers/web-search/setup.sh`).

Via dispatch: `type: "agent"`, same header, `payload.profile`; agent jobs
never fall back to another backend (the profile pins the trust boundary), and
`preferences.model` must be tool-capable (`qwen`, `kimi`).

### `POST /v1/convert` — document → markdown

Standalone conversion (PDF, DOCX, PPTX, XLSX, HTML, images, ...). Same input
shapes as `documents` entries: `{"source": "<url-or-path>"}` or
`{"filename": "x.pdf", "data": "<base64>"}` → `{"name", "markdown", "engine"}`.

The worker is `services/converter/convert.py` — a subprocess with the contract
"source in, markdown on stdout", so swapping docling for Marker is a one-file
change. Note: the **first PDF** conversion downloads docling's layout models
(~500 MB from Hugging Face), so it's slow once; HTML/DOCX are fast immediately.

### `POST /v1/execute` — Judge0 code execution (stubbed)

Returns **503 "judge0 not configured"** until `JUDGE0_URL` is set. The client
(`src/judge0Client.ts`, vendored from leetcards) is already wired; to activate:

1. Stand up Judge0 CE via Docker Compose (release archives at
   https://github.com/judge0/judge0/releases — `docker-compose up -d db redis`
   then `docker-compose up -d`). Judge0 itself is a Dockerized service; it
   cannot be embedded in Node/Python.
2. Set `JUDGE0_URL=http://localhost:2358` (and `JUDGE0_AUTH_TOKEN` if
   configured) in the compute service env and restart it.

Body matches `Judge0SubmitOptions`: `{ "sourceCode": "print(1)", "stdin": "",
"cpuTimeLimitS": 5 }`.

### `GET /health`

```json
{ "ok": true, "backends": { "hermes": {"reachable": true, "model": "hermes3:8b"},
  "claude": {"backend": "api", "ready": true, "model": "claude-sonnet-5"},
  "judge0": {"configured": false}, "converter": {"ready": true, "engine": "docling"} } }
```

### Env

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8878` | |
| `OLLAMA_URL` | `http://localhost:11434` | |
| `HERMES_MODEL` | `hermes3:8b` | any pulled Ollama model |
| `MLX_URL` | `http://127.0.0.1:8321/v1` | local MLX server (qwen) |
| `MLX_MODEL` | `mlx-community/Qwen3.5-27B-6bit` | must match what the MLX server loaded |
| `HARNESS_TOKEN` | — | unset ⇒ `/v1/agent/completions` returns 503; same value on hub + nodes |
| `HARNESS_DIR` | `config/harnesses` | profile directory |
| `CLAUDE_BACKEND` | `api` | `api` (SDK + key) or `cli` (`claude -p`, subscription auth) |
| `ANTHROPIC_API_KEY` | — | required for `CLAUDE_BACKEND=api` |
| `CLAUDE_MODEL` | `claude-sonnet-5` | |
| `OPENROUTER_API_KEY` | — | required for the kimi option (free key at openrouter.ai) |
| `KIMI_MODEL` | `moonshotai/kimi-k2.6:free` | `moonshotai/kimi-k2.6` for paid tier |
| `KIMI_URL` | `https://openrouter.ai/api/v1` | point at platform.moonshot.ai instead if preferred (then set `KIMI_API_KEY`) |
| `JUDGE0_URL` | — | unset ⇒ `/v1/execute` returns 503 |
| `JUDGE0_AUTH_TOKEN` | — | optional X-Auth-Token |
| `CONVERTER_DIR` | `services/converter` | dir holding `convert.py` + `.venv` |
| `BASE_PROMPT_FILE` | `prompts/negotiation.md` | base system prompt for all chats; `""` disables |
| `HERMES_TEMPERATURE` | `0.9` | hermes sampling default |
| `HERMES_FREQUENCY_PENALTY` | `0.5` | hermes anti-repetition default |

## Dispatch service (`:8877`)

Queue + dispatch broker. Jobs carry optional preferences: pin a model, or allow
fallback to the other model on failure. hermes jobs run one-at-a-time (single
local model); claude jobs run up to 4 in parallel.

### `POST /jobs` (async) and `POST /jobs?wait=true` (sync)

```bash
# Synchronous — one call, result inline (Telegram/UI friendly)
curl -s 'localhost:8877/jobs?wait=true' -H 'Content-Type: application/json' -d '{
  "type": "chat",
  "payload": {"messages": [{"role": "user", "content": "say hi"}]},
  "preferences": {"model": "claude", "fallback": true}
}'

# Async — returns {jobId, status:"queued"} immediately
curl -s localhost:8877/jobs -H 'Content-Type: application/json' -d '{
  "type": "chat",
  "payload": {"messages": [{"role": "user", "content": "say hi"}]}
}'
curl -s localhost:8877/jobs/<jobId>
```

- `preferences.model` — `"hermes"` | `"claude"` | `"kimi"`; omitted ⇒ round-robin.
- `preferences.fallback: true` — on chat failure, retry the remaining models in
  turn (the response's `model` field reports which one actually served it; a
  total failure lists every backend's error).
- `type: "execute"` — forwarded to compute `/v1/execute` (503 until Judge0 up).
- `type: "convert"` — forwarded to compute `/v1/convert`; payload is the
  document input (`{"source": ...}` or `{"filename", "data"}`).
- Results are in-memory with a 1 h TTL — no persistence in v1. If durable jobs
  are needed later, swap the `Map` in `src/queue.ts` for SQLite.

### Env

| Var | Default |
|---|---|
| `PORT` | `8877` |
| `COMPUTE_URLS` | `http://localhost:8878` | comma-separated compute pool (`COMPUTE_URL` also accepted) |
| `HERMES_CONCURRENCY` | `1` | per node — auto-multiplied by pool size |
| `QWEN_CONCURRENCY` | `1` | per node — a 27B model is one inference at a time |
| `CLAUDE_CONCURRENCY` | `4` |
| `KIMI_CONCURRENCY` | `4` |
| `HARNESS_TOKEN` | — | required on `agent` jobs (`x-harness-token`); forwarded to compute. Unset ⇒ agent jobs 403. Loopback is *not* trusted: the tunnel delivers public traffic to localhost. |
| `WAIT_TIMEOUT_S` | `60` |

### Compute pool — multiple laptops, one service

Dispatch fans jobs out across every node in `COMPUTE_URLS` (round-robin, with
automatic failover: an unreachable node or a 503 "backend not configured on
this node" just moves the job to the next node). Each entry is any URL the hub
can reach — localhost, a LAN IP, or (best) a tailscale hostname, since the
swarm Macs already share a tailnet:

```bash
# services/dispatch/.env on the hub
COMPUTE_URLS=http://localhost:8878,http://macbook-2.tailnet.ts.net:8878,http://100.x.y.z:8878
```

`GET /health` reports per-node status plus a `pool: {total, healthy}` summary.
hermes concurrency scales with pool size automatically (one local model per
node). Nodes can be heterogeneous — a node without an Anthropic key simply
503s claude jobs and dispatch routes them to a node that has one.

**Node discovery (preferred over hand-editing COMPUTE_URLS):** compute nodes
self-register. On the hub, set `SWARM_KEY=<random hex>` in `services/.env`
(enables `POST /nodes/register`; requests must present the key, and the hub
verifies it can reach the node's `/health` before admitting it). On each
worker, set `DISPATCH_URL=http://<hub>:8877` and the same `SWARM_KEY` — the
compute service announces its own address (preferring its tailscale 100.x IP,
overridable via `ADVERTISE_URL`), heartbeats every 60s, and the hub expires
silent nodes after ~150s. So laptops join the pool by coming online and leave
it by shutting their lid — no hub edits, no dispatch restarts. `/health`
labels each node `static` or `registered`.

## Web front end (`chat-web/`) — Cloudflare Worker

A public chat UI + API deployed to Cloudflare Workers (scaffolded with
create-cloudflare), live at **https://hermes-chat.hermes-swarm.workers.dev**
(the workers.dev URL is permanent — bound to the account, no expiry).
Persistence is fully on Cloudflare's durable primitives:

- **Durable memory** — one SQLite-backed **Durable Object** per conversation
  (class `Conversation`): strongly consistent message history with **no TTL**;
  it lives until explicitly deleted via the API/UI.
- **Durable storage** — a **D1** database (`swarm-chats`) indexing every
  conversation (title, timestamps, message count, last model) so the UI can
  list and reopen past chats from any browser.

The Worker itself is thin; inference proxies to the dispatch service over a
cloudflared tunnel.

```
browser ──▶ hermes-chat Worker ──▶ Durable Object (messages, per conversation)
                    │          ──▶ D1 (conversation index)
                    └──▶ tunnel ──▶ dispatch :8877 (this Mac)
```

Routes: `/` (chat UI with history picker), `POST /api/chat`
(`{conversationId?, message, model?, fallback?}` → `{conversationId, reply,
model}`), `GET /api/conversations` (list), `GET /api/conversations/:id`
(full history), `DELETE /api/conversations/:id`, `GET /api/health`.

Local dev (no Cloudflare account needed): `cd services/chat-web && npx wrangler
dev` → http://localhost:8787 (KV is simulated locally).

**Deploy (one time):**

```bash
cd services/chat-web
npx wrangler login                          # interactive browser auth
npx wrangler d1 create swarm-chats          # paste database_id into wrangler.jsonc
npx wrangler d1 execute swarm-chats --remote -y --command \
  "CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER, message_count INTEGER DEFAULT 0, last_model TEXT)"
# point DISPATCH_URL in wrangler.jsonc at the tunnel URL (see below)
npx wrangler deploy                         # prints the public workers.dev link
```

(The Durable Object needs no manual setup — the `migrations` block in
`wrangler.jsonc` provisions it on deploy.)

**Tunnel** — the Worker can't reach localhost; expose dispatch with
cloudflared:

- Quick (ephemeral URL, no account): `cloudflared tunnel --url
  http://localhost:8877` — URL printed at startup / in `services/tunnel.log`.
  Changes on every restart, so redeploy or `npx wrangler deploy --var
  DISPATCH_URL:<new-url>` after each.
- Named (stable hostname — same pattern as apollo/beta/alpha's dockerized
  cloudflared): create a tunnel in the Cloudflare Zero Trust dashboard (or
  `cloudflared tunnel login && cloudflared tunnel create swarm-dispatch`),
  route a hostname to `http://localhost:8877`, and put `TUNNEL_TOKEN=...` in
  `services/.env`. The launchd tunnel service (below) picks it up
  automatically. Set `DISPATCH_URL` to that hostname once and forget it.

## Local MLX model (`mlx/`) and the penguin Telegram bot (`telegram-penguin/`)

Both are opt-in launchd services (not in the default install set):

```bash
services/mlx/setup.sh --download                 # venv + Qwen3.5-27B-6bit (~21 GB, resumable)
mcp-servers/web-search/setup.sh                  # web_search MCP venv
openssl rand -hex 24                             # → HARNESS_TOKEN in services/.env (hub + nodes)
bin/swarm-svc-plists-install.sh --only mlx
launchctl kickstart -k gui/$(id -u)/com.$USER.swarm-svc.{compute,dispatch}   # pick up the token
bin/swarm-check.sh                               # qwen: ready · harness: enabled — profiles: web-readonly
```

`telegram-penguin` is a zero-dependency bot that long-polls Telegram and sends
each message to dispatch as an `agent` job (qwen + a harness profile ⇒ live web
search), falling back to plain chat if the harness is unavailable. It is
default-deny on chats: set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_CHAT_IDS`
in `services/.env` (rejected chat ids are logged so you can add them), then
`bin/swarm-svc-plists-install.sh --only telegram`. Unlike the
claude-code-telegram bots it has no shell or filesystem access — only what the
harness profile allows.

It ships tuned as a **universal get-money-back advocate**
(`config/harnesses/reimbursement-advocate.json`, override with
`PENGUIN_PROFILE`): employer/corporate expense (Rho/Brex/Ramp/Concur/…), card
chargebacks (Reg Z / Reg E, network reason codes, merchant-first), bank/ACH/
Zelle escalations (executive office → CFPB/OCC/state AG), marketplace &
platform purchase protection (Amazon A-to-z, PayPal, app stores), travel
(DOT/airline/hotel/rideshare), healthcare billing & HSA/FSA, subscriptions /
BNPL, warranties & card-linked price protection, shipping and ticket claims.
Routes are ranked so the strongest clock is not burned
(merchant/platform → employer → issuer/bank → regulator). Every reply:
intake → triage + deadlines → evidence → ready-to-send message → follow-through;
uncertain facts go through `web_search` with citations.

- **Receipts and documents.** Photos (and image documents) go to the model as
  images — qwen is a VLM, so it reads merchant/date/total/last-4 straight off
  the receipt and flags what looks off (duplicate, tip math, FX fee). PDF/DOCX/
  XLSX/HTML/CSV go through compute's docling converter (`documents[]` on the
  agent route) when that venv exists. Only the latest image is kept in chat
  context; images are never written to disk.
- **Learning loop.** Every exchange is appended to
  `services/telegram-penguin/data/turns.jsonl` (gitignored). When a case
  resolves, `/outcome won|partial|lost <what worked or didn't>` records it in
  `cases.jsonl`, and the recent outcomes are injected into every subsequent
  prompt as a "Lessons from past cases" block — tactics that won get preferred,
  ones that lost get flagged. `/lessons` shows the block. `turns.jsonl` is the
  raw material for later evals/fine-tunes.
- Commands: `/new`, `/outcome`, `/lessons`, `/tools on|off`, `/status`, `/help`.
- Jobs are polled past dispatch's 60 s long-poll cap (`PENGUIN_JOB_TIMEOUT_MS`,
  default 300 000) — a 27B model with a tool round typically takes 90–120 s.

Only one process may long-poll a bot token: if the log shows `Conflict:
terminated by other getUpdates request`, another instance (another machine, an
old hookup) holds the same token and messages will split between them.

### Throughput and concurrency

The MLX server batches concurrent requests. `services/mlx/.env.example` sets 4
decode slots with a 4-bit KV cache (`MLX_MAX_SEQS=4`, `MLX_KV_BITS=4`); copy it
to `services/mlx/.env` and set dispatch's `QWEN_CONCURRENCY` to match
(`services/dispatch/.env.example`). Measured on a 48 GiB M-series Mac with
Qwen3.5-27B-6bit:

| Load | Aggregate decode | Per stream | Peak memory |
| --- | --- | --- | --- |
| 1 request | 8.6 tok/s | 8.6 tok/s | 26.2 GB (fp16 KV) |
| 4 concurrent | 32.2 tok/s | ~8 tok/s | 24.1 GB (4-bit KV) |
| 40 requests in 1 s, 32 tokens each | ~29 tok/s, drained in ~45 s, 0 failed | ~7.3 tok/s | — |

## Model serve monitor (`status-ui/`, `:8880`)

A zero-dependency Python server with a Spark-UI-style dashboard for the local
model servers, updated live over Server-Sent Events:

```bash
bin/swarm-svc-plists-install.sh --only status-ui     # or: python3 services/status-ui/server.py
open http://127.0.0.1:8880/#active
```

- **Backend toggle** (keys `1`/`2`/`3`): Qwen3.5-27B on MLX (`:8321`),
  qwen2.5-coder:7b on Ollama (`:11434`), and the Jev scoring server
  (LLM2Jev, `:30000`). Backends that are down show red; the others keep working.
- **Jobs tab**: live tok/s and a 2-minute event timeline, active jobs (engine
  slots, queue, probe and load-test progress), and completed jobs with TTFT,
  prefill/decode rates, peak memory and token counts. Every job carries a
  source (`normal`, `probe`, `load`) with filter chips.
- **Probe**: streams one completion token by token through the monitor
  (`/api/generate`), the only way to see per-token throughput — MLX's `/metrics`
  reports requests after they finish. For Jev a probe is one `/v1/systemone`
  evaluation, measured in prompt tokens per second.
- **Load test**: `/api/load?backend=&rps=&seconds=&max_tokens=` fires up to 400
  non-streaming requests at a fixed rate. MLX records carry no request id, so the
  monitor matches its own jobs back by token counts and finish time
  (tags persist in `status-ui/tags.json`, gitignored).
- **Timeline / Executors / Environment tabs**: per-job decode bars with
  percentile summaries, all model servers side by side, and raw server
  properties.

Ollama and Jev expose no metrics API, so for them only jobs sent through the
monitor have timings; Jev's other requests are counted from `/tmp/llm2jev.log`.

## Process pickup & scheduling (this machine and other instances)

Two scripts in the repo's `bin/` follow the existing `stephanie-*` launchd
conventions:

- `bin/swarm-svc-launcher.sh <services-dir> <compute|dispatch|tunnel>` — runs
  one service, sourcing `services/.env` (shared secrets: `ANTHROPIC_API_KEY`,
  `OPENROUTER_API_KEY`, `TUNNEL_TOKEN`) then `services/<name>/.env`
  (per-service overrides) so machine-local config stays out of git.
- `bin/swarm-svc-plists-install.sh` — writes + loads one LaunchAgent per
  service (`com.$USER.swarm-svc.{compute,dispatch,tunnel,frontend}`).
  `RunAtLoad` picks them up at login/boot, `KeepAlive` restarts crashes.
  Idempotent; flags: `--only <svc>` (e.g. worker nodes install just compute),
  `--no-load` (write only), `--uninstall`. Logs land in `services/<name>.log`.
- `bin/swarm-svc-recover.sh` — **health-driven recovery**, catching what
  KeepAlive can't: hung processes still holding their port, a wedged ollama,
  a silently-dead cloudflared. Probes each service's health endpoint (tunnel:
  process check; ollama: `/api/tags`) and `launchctl kickstart -k`s anything
  unhealthy, then re-runs `swarm-check`. **Only manages services whose plist
  is installed** — ad-hoc/nohup processes are dev mode and left alone, so on
  a machine without plists it's a guaranteed no-op. Flags: `--dry-run`,
  `--install-watchdog` (launchd timer running recovery every 5 min, logging
  to `services/recovery.log`), `--uninstall-watchdog`.
  `swarm-node-setup.sh` installs the watchdog automatically on new laptops.

```bash
# take over from ad-hoc processes on this machine:
lsof -ti:8877 -ti:8878 | xargs kill      # stop hand-started copies first
~/Desktop/apollo/beta/hermes_swarm/bin/swarm-svc-plists-install.sh
launchctl list | grep swarm-svc         # verify
```

**Onboarding a new laptop into the compute pool** (two commands):

```bash
git clone https://github.com/IamJasonBian/stephanie_swarm.git ~/stephanie_swarm
~/stephanie_swarm/bin/swarm-node-setup.sh              # worker: compute only
# or, for a machine that should run the broker + tunnel too:
~/stephanie_swarm/bin/swarm-node-setup.sh --role hub
```

`swarm-node-setup.sh` installs missing brew deps (node/ollama/uv/jq,
+cloudflared for hubs), pulls the hermes model, npm-installs the services,
builds the docling venv, writes a `services/.env` template, installs the
launchd services for its role, runs `swarm-check`, and finally prints the
exact `COMPUTE_URLS` line to add on the hub (preferring the machine's
tailscale hostname). Add that line to the hub's `services/dispatch/.env`,
kick dispatch, done.

**Connectivity check** — one command, from any machine:

```bash
bin/swarm-check.sh                                  # local node + localhost hub + public link
bin/swarm-check.sh http://hub-mac.tailnet.ts.net:8877   # point at a remote hub
```

Prints ✓/✗ for the local compute node (model, keys, docling), the dispatch
hub (pool health, queue depth), and the public Cloudflare link end-to-end.
Exit code 0 ⇔ dispatch is reachable with at least one ready backend — usable
from cron/monitoring.

**Failover / shared pickup:** with a named tunnel, the `TUNNEL_TOKEN` is the
handoff mechanism — whichever machine runs the tunnel service owns the public
hostname. Cloudflare supports **multiple simultaneous replicas** of the same
tunnel: run the full stack (all three plists) on two or more machines with the
same token and Cloudflare load-balances requests across them and fails over
automatically when one goes down. Each machine needs its own `ollama pull`
(models are per-machine); API keys travel in `services/.env`. The deployed
Worker never changes — it only knows the tunnel hostname.
