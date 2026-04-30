#!/bin/bash
# Generates a snapshot of bot↔account↔process mapping and pushes it to the gist
# alongside stephanie-uptime.log. Auto-discovers any /Users/jasonzb/claude-code-telegram*/.

set -u

GIST_ID="6944ac3b7c93b7d25cba18f27f33b73b"
GH_BIN="/opt/homebrew/bin/gh"
JQ_BIN="/opt/anaconda3/bin/jq"
WORKDIR_GLOB="/Users/jasonzb/claude-code-telegram*"

bot_row() {
  local dir="$1"
  local env="$dir/.env"
  local db="$dir/data/bot.db"

  local pid uptime token bot_id username claude_dir
  pid=$(/usr/sbin/lsof -t -- "$db" 2>/dev/null | head -1)
  if [[ -n "$pid" ]]; then
    uptime=$(/bin/ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
  else
    uptime="DOWN"
    pid="—"
  fi
  token=$(/usr/bin/grep -E '^TELEGRAM_BOT_TOKEN=' "$env" 2>/dev/null | head -1 | cut -d= -f2-)
  claude_dir=$(/usr/bin/grep -E '^CLAUDE_CONFIG_DIR=' "$env" 2>/dev/null | head -1 | cut -d= -f2-)
  bot_id="${token%%:*}"
  username=$(/usr/bin/curl -fsS --max-time 5 \
               "https://api.telegram.org/bot${token}/getMe" 2>/dev/null \
               | "$JQ_BIN" -r '.result.username // "unknown"')

  printf '| @%-20s | %-10s | %s | %s | %s | %s |\n' \
    "$username" "$bot_id" "$dir" "${claude_dir:-—}" "$pid" "$uptime"
}

now=$(/bin/date "+%Y-%m-%d %H:%M:%S %Z")
out=$(mktemp)
{
  printf '# Stephanie bot topology — generated %s\n\n' "$now"
  printf 'Auto-discovered from `%s`. Re-run `~/bin/stephanie-mapping-push.sh` to refresh.\n\n' "$WORKDIR_GLOB"
  printf '| Telegram bot | Bot ID | Working dir | CLAUDE_CONFIG_DIR | PID | Process uptime |\n'
  printf '|---|---|---|---|---|---|\n'
  for dir in $WORKDIR_GLOB; do
    [[ -d "$dir" && -f "$dir/.env" ]] || continue
    bot_row "$dir"
  done
  printf '\n## Notes\n\n'
  printf -- '- Each bot uses `CLAUDE_CONFIG_DIR` for isolated Claude auth. Some bots may share a CLAUDE_CONFIG_DIR (and thus share the same Claude account / rate limit).\n'
  printf -- '- Alerts use the `@username` resolved live via Telegram `getMe`. The script no longer hardcodes labels or tokens.\n'
  printf -- '- User chat ID for failure alerts: `5921617034`.\n'
  printf '\n## Downtime management\n\n'
  printf -- '- **Local monitor (every 60s):** `~/bin/stephanie-uptime.sh` auto-discovers all `claude-code-telegram*/` working dirs, checks `lsof` on `bot.db` + Telegram `getMe`. Either fails → Telegram alert. Edge-triggered.\n'
  printf -- '- **Gist mirror (every 10min):** `~/bin/stephanie-uptime-gist-push.sh` PATCHes the rolling log into this gist.\n'
  printf -- '- **Heartbeat (dead-mans switch):** if `~/.config/stephanie-uptime.conf` defines `HEALTHCHECKS_URL=...`, the monitor pings it every tick; healthchecks.io alerts independently if pings stop. Mac-off / network-out / monitor-crashed all detectable. (Set the URL after signing up at healthchecks.io.)\n'
  printf -- '- **Two-week audit:** routine `trig_01DNqfMXkFtWm9yNq6mBBvF3` fires once on `2026-05-14T13:00:00Z`, parses the gist, classifies outages, Telegrams the summary.\n'
  printf -- '- **Auto-restart on crash/reboot:** NOT wired. Bots run via `nohup &` and die on logout/reboot. Putting them under launchd plists with `KeepAlive=true` is the next step.\n'
  printf '\n## Adding a new bot\n\n'
  printf -- '1. Create `/Users/jasonzb/claude-code-telegram-<name>/` with a `.env` (`TELEGRAM_BOT_TOKEN`, `CLAUDE_CONFIG_DIR`, etc.).\n'
  printf -- '2. Start it (`cd <dir> && nohup ~/.local/bin/claude-telegram-bot > bot.log 2>&1 &`) — this creates `data/bot.db`.\n'
  printf -- '3. Next tick of the monitor (within 60s) auto-detects it. No script changes needed.\n'
  printf -- '4. Re-run `~/bin/stephanie-mapping-push.sh` to refresh this gist.\n'
} > "$out"

CONTENT=$(cat "$out")
TOKEN=$("$GH_BIN" auth token -u stephanieisapenguin)
PAYLOAD=$("$JQ_BIN" -n --arg content "$CONTENT" \
  '{files: {"stephanie-mapping.md": {content: $content}}}')

HTTP=$(/usr/bin/curl -sS -o /tmp/stephanie-mapping-push.out -w '%{http_code}' \
  -X PATCH "https://api.github.com/gists/${GIST_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  --data-binary "$PAYLOAD")

rm -f "$out"
if [[ "$HTTP" == "200" ]]; then
  echo "OK pushed mapping ($(/bin/ls -d $WORKDIR_GLOB 2>/dev/null | wc -l | tr -d ' ') working dirs)"
else
  echo "FAIL http=$HTTP"; head -c 500 /tmp/stephanie-mapping-push.out; exit 1
fi
