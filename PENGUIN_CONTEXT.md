# 🐧 Penguin Context

**Source of truth:** `/Users/jasonzb/stephanie_swarm/PENGUIN_CONTEXT.md` (this file, git-tracked at https://github.com/stephanieisapenguin/stephanie_swarm).

**How the bots read it:** `/Users/jasonzb/.claude-stephanie2/PENGUIN_CONTEXT.md` is a symlink → this file. Inside the shared `CLAUDE_CONFIG_DIR=/Users/jasonzb/.claude-stephanie2/`, `CLAUDE.md` is a symlink → `PENGUIN_CONTEXT.md`. So every bot's Claude session auto-loads this content as user-level memory with zero copy.

**Edit workflow:** edit *this file in the repo*, commit, push. Bots pick it up live on the next Claude session (symlinks resolve fresh each time). No copy step.

**@-import from anywhere:** `@/Users/jasonzb/.claude-stephanie2/PENGUIN_CONTEXT.md` (resolves via symlink) or `@/Users/jasonzb/stephanie_swarm/PENGUIN_CONTEXT.md` (direct).

## Context surfaces — what loads where

The stephanie ops world has three distinct context surfaces. Knowing which is which prevents "wrote it but no one read it" mistakes:

| Surface | Path | Loaded by | Use it for |
|---|---|---|---|
| **This file (PENGUIN_CONTEXT.md)** | `~/stephanie_swarm/PENGUIN_CONTEXT.md` (symlinked to `~/.claude-stephanie2/CLAUDE.md`) | every Claude session spawned by any of the 9 bots, as user-level memory via the shared `CLAUDE_CONFIG_DIR` | facts/gotchas/conventions the **bots** need to know mid-conversation. Includes the load-bearing gotcha that the running bot loads code from `/Users/jasonzb/.local/share/uv/tools/claude-code-telegram/lib/python3.13/site-packages/src/...` (NOT the source checkout). |
| **User Claude Code memory** | `~/.claude/projects/-Users-jasonzb/memory/*.md` (e.g. `project_bot_workdir_vs_working_directory.md`, `reference_penguin_context.md`) | ONLY the user's own Claude Code session (the one editing this stack locally). NOT loaded by the bots. | reminders/conventions for the developer working on the stack. The "Bot process cwd vs SDK working_directory" memory lives here, so future agent sessions catch the same gotcha before retracing the debug. |
| **Repo `RECOVERY.md`** | `~/stephanie_swarm/RECOVERY.md` (also on GitHub) | a human reading the repo, or an agent that's been pointed at the repo. NOT auto-loaded anywhere. | symptom→fix playbook + standalone "how do I edit orchestrator behavior" reference. Useful when restoring service from a different machine, or onboarding someone new. |

**Quick rule:**
- If the **bots' in-conversation behavior** depends on the info → put it here.
- If your **local Claude Code session** needs to remember it → put a memory entry under `~/.claude/projects/-Users-jasonzb/memory/`.
- If a **human** needs to find it during an outage → put it in `RECOVERY.md`.

Critical facts are duplicated across all three on purpose so nothing falls through.

---

## Latency profile (measured 2026-05-26 across 249 sessions)

Claude SDK invocation time, end-to-end (i.e. wall-clock from the bot calling `run_command` to the SDK returning):

| Percentile | Time |
|---|---|
| P50 | **15.9 s** — single API call, no tool loop |
| P95 | **139.7 s** (~2.3 min) |
| P99 | **451.7 s** (~7.5 min) |

P50 corresponds to `num_turns: 1` — one short Claude API turn, no tool use. The tail is *not* "Claude is slow"; it's "Claude is doing something specific the entire time."

### Likely causes of the tail (ranked)

1. **Multi-turn tool-use loops.** `run_command` returns when the whole conversation is done — including every Bash/Read/Edit Claude calls along the way. 30 turns × ~10 s/turn = 5 min. Verify: `jq -r '"\(.duration_ms) \(.num_turns)"' <bot.log>` and sort. The top sessions correlate `num_turns` with `duration_ms`.

2. **MCP roundtable / dispatch / background_task calls inside a Claude conversation.** `mcp__stephanie-network__roundtable` alone costs **30–60 s** and shows up as part of the parent session's duration.

3. **Shared Claude account + Anthropic rate-limit backoff.** All 9 bots share `~/.claude-stephanie2/` (`cloud@optimchain.org`). Concurrent calls hit per-account limits; SDK retries with exponential backoff. A few 429s can add 30 s – 2 min.

4. **Stream-callback blocking on Telegram `editMessageText` flood protection.** When `verbose ≥ 1` the bot edits a progress message every 2 s. Telegram caps `editMessageText` at ~1/sec per chat. PTB's `AIORateLimiter` awaits until the slot opens, which freezes the SDK's message receive loop and inflates the recorded duration.

5. **Long-running individual tool calls.** WebFetch to a slow site, a big `git clone`, an unbounded Bash command — all blocked time is "Claude duration" in the metric.

6. **MacBook resource starvation.** 9 bot processes + spawned `claude` CLI subprocesses + MCP servers contend on CPU/memory. Under thermal throttling, each subprocess gets slow.

---

## Mitigations live in production (as of 2026-05-26)

All mitigations live in the installed copy of `src/bot/orchestrator.py` at `/Users/jasonzb/.local/share/uv/tools/claude-code-telegram/lib/python3.13/site-packages/src/` — NOT the source checkout. All three layers are deterministic, no-LLM:

- **Instant ACK** — `🐧 thinking…` placeholder fires *before* rate-limit or any heavy setup. Edited in-place to `Working...` once Claude starts streaming.
- **Regex pre-filter (`MOCK_RESPONSES.json:patterns` in each bot workdir)** — short-circuits 10 categories before any Claude call:
  - Identity → `I am a safe, unhackable, and fast penguin 🐧`
  - Run script / dangerous shell / bulk delete / system control / reverse shell / sensitive files / git destruction / container destruction / secrets → contextual `🧊 …` warning.
- **Pre-flight warning (`MOCK_RESPONSES.json:preflight`)** — when prompt regex-matches `run|execute|deploy|install|provision`, send `🐧 This might make the penguins work too hard.` as an extra message, then continue to Claude. Doesn't abort. Costs one Telegram round-trip.
- **No-LLM watchdog (`MOCK_RESPONSES.json:limits`)** wrapping the Claude call:
  - `max_seconds: 300` — wall-clock cap. Cancels the run task. Reply: `🧊 This is using too much snow. (5-min wall-clock cap reached — request aborted)`.
  - `max_tool_calls: 15` — counts `{"kind":"tool"}` entries in `tool_log`; cancels at the threshold. Reply: `🧊 This is using too much snow. (15 tool-call cap reached — Claude went down a rabbit hole)`.
- **No global async lock in the running code.** The lock in source `update_processor.py` does NOT exist in the installed venv copy. Each message handler runs concurrently.

`MOCK_RESPONSES.json` is reread on every message — all three regex/limit knobs are tunable without bot restart.

## Where to edit (cheat-sheet)

| Change kind | Edit here | Restart required |
|---|---|---|
| Regex patterns (short-circuit, preflight) or limits thresholds | `/Users/jasonzb/claude-code-telegram-<bot>/MOCK_RESPONSES.json` (per bot) | none — reread per message |
| This shared context doc | `/Users/jasonzb/stephanie_swarm/PENGUIN_CONTEXT.md` (repo) — `~/.claude-stephanie2/PENGUIN_CONTEXT.md` is a symlink to it | none — symlink resolves fresh per session |
| Persona (per-bot identity override) | `<bot-workdir>/PERSONA.md` (NB: bot reads via `Path.cwd()`, not via SDK `working_directory`) | bounce that bot for fresh session |
| **Bot Python source (orchestrator, SDK integration, etc.) — THIS IS THE TRAP** | `/Users/jasonzb/.local/share/uv/tools/claude-code-telegram/lib/python3.13/site-packages/src/...` ← what the bot actually loads. **NOT** `/Users/jasonzb/claude-code-telegram/src/...` (source checkout isn't loaded; would need `uv tool install --reinstall .` to deploy from there) | bounce affected bots |
| Bot launchd config | `/Users/jasonzb/Library/LaunchAgents/com.jasonzb.stephanie-bot.claude-code-telegram-<name>.plist` (generated by `~/bin/stephanie-bots-plists-install.sh`) | reload via `launchctl bootout` + `bootstrap` |
| Bot launcher / monitor / gist push scripts | `~/bin/stephanie-*.sh` (live deploy); back-port to `~/stephanie_swarm/bin/` for git | depends on script; uptime monitor reads itself on each tick |
| Bot env (token, CLAUDE_CONFIG_DIR, APPROVED_DIRECTORY, ALLOWED_USERS, …) | `<bot-workdir>/.env`, `chmod 600` | bounce that bot |
| Shared MCP config | `/Users/jasonzb/.config/stephanie-network/mcp.json` | bounce all (each bot spawns its own MCP server subprocesses) |
| Shared MCP server source | `/Users/jasonzb/mcp-servers/stephanie-network/server.py`; back-port to `~/stephanie_swarm/mcp-servers/...` | bounce all |
| Claude account auth | `CLAUDE_CONFIG_DIR=<dir> claude` → `/login` → `/quit`. All bots sharing that CCD pick it up on the next subprocess. | none (no bot restart needed) |
| P99 logger threshold | `~/bin/penguin-p99-scan.sh` (`THRESHOLD_MS` constant); also `~/stephanie_swarm/bin/`. launchd: `com.jasonzb.penguin-p99`, 5-min interval | none (script reread on each run) |
| Healthcheck URL | `~/.config/stephanie-uptime.conf` | none (sourced per tick by uptime script) |

**Edit-flow rule of thumb:** if it's "live deployed" (in `~/bin/`, `~/Library/LaunchAgents/`, `~/.config/`, or inside `~/.local/share/uv/tools/...`), edit *there* — and remember to back-port the change to the repo (`~/stephanie_swarm/`) so it's git-tracked. If it's a config JSON in a bot workdir, just edit; it's already where the bot reads it.

## Things to avoid / known gotchas

- **Bot process cwd ≠ Claude SDK `working_directory`.** The bot reads `MOCK_RESPONSES.json` and `PERSONA.md` from `Path.cwd()` (set by the launcher); the SDK's `working_directory` is `APPROVED_DIRECTORY` = `/`. CLAUDE.md loading in source `sdk_integration.py:304` uses `working_directory` and so silently never fires for any bot.
- **Edits to `/Users/jasonzb/claude-code-telegram/src/` do not run.** The bot is installed via `uv tool install`. Edit `/Users/jasonzb/.local/share/uv/tools/claude-code-telegram/lib/python3.13/site-packages/src/...` instead, or `uv tool install --reinstall .` to refresh from source.
- **All 9 bots share one Claude account.** Watch the rate-limit math when adding more.
- **Sessions auto-resume per `(user, working_directory)`.** Settings changes (CLAUDE.md, system prompt) don't reach an in-flight session — user must `/new` or you must bounce.

## P99 event log (>10 min Claude sessions)

Long-running Claude sessions get appended to a single log file as they happen:

- **`/Users/jasonzb/.claude-stephanie2/PENGUIN_P99_EVENTS.log`** — append-only, one line per event.

Format: `<iso8601-timestamp>  bot=<workdir-name>  duration=<sec>s  turns=<n>  cost=$<usd>  ok|ERROR  session=<uuid>`

Wired by `~/bin/penguin-p99-scan.sh` (Python), scheduled by `~/Library/LaunchAgents/com.jasonzb.penguin-p99.plist` every 5 min. Dedup state in `~/Library/Application Support/penguin-p99/<bot>.last`. Threshold is hardcoded at 600,000 ms (10 min).

To inspect: `tail -f ~/.claude-stephanie2/PENGUIN_P99_EVENTS.log`. To raise/lower the threshold, edit `THRESHOLD_MS` in the script. Historical baseline (before this logger existed): worst session ever was 501s (~8.4 min) — no events exceeded 10 min, so the log starts empty and only grows when actual tail events occur.

## Operational landmarks

- Repo (source of truth for ops scripts): https://github.com/stephanieisapenguin/stephanie_swarm
- Gist (rolling logs + topology): https://gist.github.com/stephanieisapenguin/6944ac3b7c93b7d25cba18f27f33b73b
- Healthchecks: https://healthchecks.io/checks/cac90552-e328-4ed2-b9a3-e6afb470bec4/details/
- Recovery handbook: `~/stephanie_swarm/RECOVERY.md`
- Audit routine (2026-05-14 fired; check routine page for next): https://claude.ai/code/routines/trig_01DNqfMXkFtWm9yNq6mBBvF3
- User chat ID for alerts: `5921617034`
