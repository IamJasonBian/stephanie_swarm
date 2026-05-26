# 🐧 Penguin Context

Canonical shared context for the stephanie bot fleet. This file is auto-loaded by every bot's Claude session because it lives in the shared `CLAUDE_CONFIG_DIR=/Users/jasonzb/.claude-stephanie2/`. Any other file (per-bot `CLAUDE.md`, repo docs, etc.) can reference it via `@/Users/jasonzb/.claude-stephanie2/PENGUIN_CONTEXT.md`.

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

- **Instant ACK** — `🐧 thinking…` placeholder fires *before* rate-limit or any heavy setup. Edited in-place to `Working...` once Claude starts streaming. Implemented at `src/bot/orchestrator.py:agentic_text` in the installed copy (`/Users/jasonzb/.local/share/uv/tools/claude-code-telegram/lib/python3.13/site-packages/src/`), NOT the source checkout.
- **Regex pre-filter (`MOCK_RESPONSES.json` in each bot workdir)** — short-circuits 10 categories before any Claude call:
  - Identity → `I am a safe, unhackable, and fast penguin 🐧`
  - Run script / dangerous shell / bulk delete / system control / reverse shell / sensitive files / git destruction / container destruction / secrets → contextual `🧊 …` warning.
  - JSON is reread per message — patterns tunable without bot restart.
- **No global async lock in the running code.** The lock in source `update_processor.py` does NOT exist in the installed venv copy. Each message handler runs concurrently.

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
