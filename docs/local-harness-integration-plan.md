# Local model and MCP harness integration plan

## Goal

Connect locally hosted MLX models—starting with
`mlx-community/Qwen3.5-27B-6bit`—to the Stephanie swarm, and let selected
clients run bounded MCP tool loops without changing the safety or behavior of
existing plain-chat routes.

The first target machine already proves the core components:

- Apple Silicon with 48 GiB RAM
- Qwen3.5 27B 6-bit in the standard Hugging Face cache (~21.2 GiB)
- `mlx_vlm.server`, which exposes OpenAI-compatible chat and tool-call output
- a terminal model manager (`models`) with offline chat, web chat, and a stdio
  `web_search` MCP server

The repo should absorb the reusable service/configuration pieces rather than
depending permanently on files under one user's `~/.local` directory.

## Current architecture and gaps

The existing request path is:

```text
Cloudflare/Telegram
        |
        v
dispatch :8877  --->  compute :8878  ---> Ollama / Claude / Kimi
```

Useful foundations already exist:

- `services/compute` normalizes three backends behind
  `POST /v1/chat/completions`.
- `services/dispatch` provides queueing, backend concurrency, compute-node
  discovery, and node failover.
- `bin/swarm-node-setup.sh` and the launchd scripts provide repeatable service
  installation and recovery.
- `mcp-servers/` and `config/mcp.json` provide working stdio MCP examples.

The main gaps are:

1. MLX is not a compute backend or advertised node capability.
2. `ChatMessage` only represents `{role, content}`. Tool calls and tool results
   cannot pass through the compute layer.
3. No swarm service owns an agent loop. The current backends make exactly one
   model call and return.
4. Backend aliases are hard-coded in compute, dispatch, and the web UI.
5. MCP configuration contains machine-specific absolute paths and has no
   read-only versus mutating tool policy.
6. Public chat reaches dispatch through Cloudflare. Automatically attaching
   local shell/network tools to that route would create a remote-code-execution
   boundary unless authentication and policy are added first.

## Design principle: backend and harness are separate

A **backend** generates a response. A **harness** may repeatedly call the
backend, execute approved tools, append tool results, and ask the backend to
continue.

Keep both request paths:

```text
Direct chat:
client -> dispatch -> compute /v1/chat/completions -> MLX -> response

Harnessed chat:
trusted client -> dispatch -> compute /v1/agent/completions
               -> harness -> MLX -> MCP tool -> MLX -> response
```

This separation provides:

- a simple way to test and benchmark the model without tools;
- explicit opt-in for tool execution;
- different auth and exposure rules for direct versus harnessed requests;
- reusable harness profiles (`web-readonly`, `stephanie-ops`, etc.);
- no requirement that an OpenAI-compatible client itself implement MCP.

Hermes does not need to sit between Qwen and MCP. Qwen3.5 and
`mlx_vlm.server` already support OpenAI-shaped tool definitions and tool-call
responses. Hermes/Ollama can remain an independent backend.

## Proposed target architecture

```text
                                         +-> Ollama (hermes3:8b)
                                         +-> Claude
client -> dispatch -> compute :8878 -----+-> Kimi
                    |                    +-> MLX server :8321 (Qwen3.5)
                    |
                    +-> local harness
                         |  bounded OpenAI tool-call loop
                         +-> MCP client manager
                              +-> web-search (read-only)
                              +-> nyc-tow-finder (read-only)
                              +-> stephanie-network (mutating/privileged)
```

`mlx_vlm.server` should bind to `127.0.0.1` by default. Other swarm machines
continue to reach it through that node's compute service, not by exposing the
raw model port.

## API and data contracts

### 1. Preserve direct OpenAI-compatible chat

Add a `qwen` backend alias to `POST /v1/chat/completions`. Its adapter forwards
to:

```text
MLX_URL=http://127.0.0.1:8321/v1
MLX_MODEL=mlx-community/Qwen3.5-27B-6bit
```

The adapter should pass through standard OpenAI fields rather than reducing
messages to text:

- `messages[].tool_calls`
- `messages[].tool_call_id`
- `tools`
- `tool_choice`
- sampling and token-limit fields already supported today

Direct chat returns tool calls but does not execute them.

### 2. Add an explicit harness route

Add `POST /v1/agent/completions` with this initial request shape:

```json
{
  "model": "qwen",
  "profile": "web-readonly",
  "messages": [{"role": "user", "content": "Look up today's Apple news"}],
  "limits": {"max_tool_rounds": 4, "timeout_ms": 120000}
}
```

Return a normal chat-completion object plus optional harness metadata:

```json
{
  "choices": [{"message": {"role": "assistant", "content": "..."}}],
  "harness": {
    "profile": "web-readonly",
    "tool_calls": 1,
    "elapsed_ms": 9200
  }
}
```

Do not overload `/v1/chat/completions` with implicit server-side execution.
Clients must choose the agent route deliberately.

### 3. Extend dispatch without weakening existing routes

Add `agent` to `JobType` and route it to `/v1/agent/completions`. Add
`QWEN_CONCURRENCY=1`; a 27B model on a 48 GiB Mac should be treated as a
single inference slot until measurements justify otherwise.

Fallback behavior needs an explicit rule:

- direct `chat` jobs may retain backend fallback;
- `agent` jobs may only fall back to a backend that supports the requested
  tool-call contract;
- a profile must never silently fall back from local/read-only execution to a
  cloud or privileged harness.

## Components to add

### A. Generic OpenAI-compatible backend adapter

Add `services/compute/src/backends/openaiCompatible.ts` and use it for MLX
first. It should:

- take base URL, served model ID, public alias, and optional bearer token;
- proxy chat requests without dropping tool fields;
- normalize model names in responses;
- expose a health/model probe;
- distinguish unavailable (503/failover-safe) from malformed model output.

This avoids another backend implementation for every local runtime that
speaks the OpenAI API (MLX, llama.cpp, vLLM, LocalAI).

### B. Harness service module

Add `services/compute/src/harness/`:

- `profiles.ts` — load and validate named profiles;
- `mcpClient.ts` — spawn/reuse stdio MCP servers and list/call tools;
- `agentLoop.ts` — model → tool → model loop;
- `policy.ts` — allowlists, limits, output truncation, and audit events.

Use `@modelcontextprotocol/sdk` in the existing Node compute process for v1.
A separate process can be introduced later if crashes or Python-only
dependencies make isolation necessary.

The loop stops on the first of:

- final assistant text;
- `max_tool_rounds` (default 4);
- wall-clock timeout (default 120 seconds);
- repeated identical tool call;
- tool output budget (default 64 KiB total);
- client cancellation.

### C. Harness profiles

Commit portable templates under `config/harnesses/`. Resolve `${HOME}` and
repo-relative paths at runtime; do not commit usernames or virtualenv hashes.

Initial profiles:

| Profile | Tools | Exposure |
|---|---|---|
| `web-readonly` | `web_search` | authenticated local/Tailscale clients |
| `public-readonly` | tightly limited search only, optional later | Cloudflare UI after auth/rate limits |
| `stephanie-ops` | network dispatch, roundtable, recipient mutations | local operator only |

Each profile specifies:

- MCP server command/args/env allowlist;
- allowed tool names;
- whether a tool is read-only or mutating;
- per-tool timeout and output limit;
- whether confirmation is required;
- client/network policy allowed to select it.

Move or recreate the prototype `web_search` server under
`mcp-servers/web-search/` with a locked dependency file and tests. Do not make
production depend on `~/.local/bin/models mcp`.

### D. MLX lifecycle

Add an `mlx` service option to the existing launchd machinery:

- `bin/swarm-svc-launcher.sh ... mlx`
- plist generation in `swarm-svc-plists-install.sh`
- health/recovery support in `swarm-svc-recover.sh`
- checks in `swarm-check.sh`

Use a repo-managed virtual environment (for example
`services/mlx/.venv`) and the shared Hugging Face cache. Suggested command:

```bash
python -m mlx_vlm.server \
  --host 127.0.0.1 \
  --port 8321 \
  --model mlx-community/Qwen3.5-27B-6bit \
  --max-num-seqs 1
```

Setup must be opt-in because the model download is ~21.2 GiB:

```bash
bin/swarm-node-setup.sh --local-runtime mlx --model mlx-community/Qwen3.5-27B-6bit
```

The default node setup should not download this model or replace Hermes.

### E. Capability-aware routing

Keep the current node health response, but make its `backends` object the
source of truth. A Qwen job should only be offered to nodes reporting
`backends.qwen.ready=true`.

Registration should eventually include stable node metadata:

```json
{
  "url": "http://100.x.y.z:8878",
  "capabilities": {
    "backends": ["hermes", "qwen"],
    "harness_profiles": ["web-readonly"]
  }
}
```

The hub must verify claimed capabilities against `/health`; it must not trust
registration payloads alone.

Replace hard-coded model arrays in the Cloudflare worker with dispatch model
discovery once the compute API is stable. Until then, add `qwen` consistently
to compute, dispatch, and UI constants in one change.

## Security boundary

Tool execution is more sensitive than model inference. Before exposing an
agent route through the existing tunnel:

1. Add bearer-token authentication between Cloudflare and dispatch.
2. Keep `stephanie-ops` unavailable to the Cloudflare worker regardless of
   token.
3. Bind MLX and stdio MCP processes to the compute host; expose only compute.
4. Treat web results and MCP output as untrusted prompt content.
5. Never inherit the full compute-service environment into MCP subprocesses.
   Pass only declared environment variables.
6. Default-deny unknown profiles, servers, and tool names.
7. Require confirmation for mutating tools. A noninteractive/public caller
   cannot satisfy confirmation and receives a policy error.
8. Emit structured audit records with request ID, profile, tool name,
   duration, result size, and outcome—never arguments that may contain
   secrets.
9. Apply SSRF controls to any future URL-fetch tool. Search-only is safer but
   still needs timeouts and output caps.
10. Preserve the bot watchdog model: tool-round and wall-clock limits are
    deterministic, not prompt instructions.

## Delivery phases

### Phase 0 — capture the prototype

- Add a web-search MCP server to the repo.
- Add portable harness-profile schemas and config validation.
- Document local commands and threat boundaries.
- No production route changes.

**Exit:** MCP inspector/client can list and call `web_search`; invalid config
and unknown tools fail closed.

### Phase 1 — Qwen as a direct backend

- Add the generic OpenAI-compatible adapter and `qwen` alias.
- Add MLX launchd/setup/recovery support.
- Advertise Qwen health and route direct chat through dispatch.
- Add contract tests with a fake OpenAI server; do not require a 21 GiB model
  in CI.

**Exit:** `curl /v1/chat/completions` with `model=qwen` succeeds locally and
through dispatch; a dead MLX server yields 503 and node failover.

### Phase 2 — read-only local harness

- Implement the MCP client manager and bounded agent loop.
- Add `/v1/agent/completions` and dispatch `agent` jobs.
- Enable only `web-readonly`.
- Add tool-call transcript and prompt-injection tests.

**Exit:** a current-information prompt causes one real MCP search and a cited
answer; a normal greeting makes no tool call; loops, oversized output, and
timeouts terminate predictably.

### Phase 3 — trusted clients and UI

- Add dispatch authentication and profile authorization.
- Add an explicit "Web tools" mode to the web/Telegram clients.
- Surface tool activity and source URLs.
- Keep the default mode as direct chat.

**Exit:** unauthenticated callers cannot select any harness; authenticated
users can choose `web-readonly`; the UI clearly indicates tool execution.

### Phase 4 — privileged Stephanie operations

- Adapt `stephanie-network` to portable paths and structured errors.
- Add confirmation/audit handling for mutating tools.
- Restrict `stephanie-ops` to local operator identities.
- Measure contention with Telegram bot MCP subprocesses before sharing server
  processes.

**Exit:** privileged tools are inaccessible from the public route and every
mutation has an attributable audit record.

## File-level implementation map

Likely changes by phase:

```text
services/compute/src/index.ts
services/compute/src/backends/openaiCompatible.ts
services/compute/src/harness/{agentLoop,mcpClient,policy,profiles}.ts
services/compute/package.json
services/dispatch/src/{index,queue}.ts
services/chat-web/src/index.ts
services/mlx/
mcp-servers/web-search/
config/harnesses/*.json
bin/swarm-node-setup.sh
bin/swarm-svc-launcher.sh
bin/swarm-svc-plists-install.sh
bin/swarm-svc-recover.sh
bin/swarm-check.sh
services/README.md
RECOVERY.md
```

## Verification matrix

Automated tests should cover:

- OpenAI request/response pass-through, including tool-call fields;
- backend health, timeout, malformed JSON, and 503 classification;
- MCP startup failure, protocol failure, timeout, and process cleanup;
- unknown/denied/mutating tool policy;
- repeated-call and max-round loop termination;
- tool-output truncation;
- dispatch capability routing and failover;
- agent jobs never falling back to an incompatible backend/profile;
- secrets excluded from logs and child-process environments.

Machine smoke tests:

1. Start MLX under launchd and verify it is loopback-only.
2. Run a direct Qwen chat through compute and dispatch.
3. Run `web-readonly` and verify a real search plus cited answer.
4. Stop MLX and verify health/failover.
5. Kill an MCP subprocess and verify cleanup/restart.
6. Send a prompt-injection string in search results and verify it remains
   quoted data rather than instructions.
7. Reboot/login and verify launchd pickup and recovery.

## Decisions to make before Phase 2

1. **Authentication identity:** shared service token first, or signed
   per-client identity immediately?
2. **Confirmation channel:** synchronous API challenge, Telegram approval, or
   local-only interactive confirmation?
3. **Audit sink:** JSONL on each compute node, SQLite on the hub, or both?
4. **Server lifetime:** keep the 27B model resident for latency, or unload
   after an idle timeout to coexist with other local workloads?
5. **Public search:** allow a constrained profile through Cloudflare, or keep
   all tool use on Tailscale/local clients?

The recommended first implementation is Phases 0 and 1 only. They add a
reusable local backend and a tested MCP building block without widening the
current public trust boundary. Phase 2 should land only after profile policy
and dispatch authentication have concrete tests.
