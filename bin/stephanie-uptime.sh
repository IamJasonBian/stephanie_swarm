#!/bin/bash
# Uptime monitor for the stephanie-* Telegram bots.
# Auto-discovers any working dir matching /Users/jasonzb/claude-code-telegram*/
# that has both .env (with TELEGRAM_BOT_TOKEN) and data/bot.db.
# Reads tokens from each bot's .env at runtime — no per-bot config in this script.

set -u

ALERT_CHAT_ID="5921617034"
LOG="$HOME/Library/Logs/stephanie-uptime.log"
STATE_DIR="$HOME/Library/Application Support/stephanie-uptime"
HC_CONF="$HOME/.config/stephanie-uptime.conf"     # may set HEALTHCHECKS_URL=...
WORKDIR_GLOB="/Users/jasonzb/claude-code-telegram*"

mkdir -p "$STATE_DIR"
[[ -f "$HC_CONF" ]] && source "$HC_CONF"   # provides HEALTHCHECKS_URL if set

ts() { date "+%Y-%m-%dT%H:%M:%S%z"; }
log() { printf '%s %s\n' "$(ts)" "$*" >> "$LOG"; }

# Resolve a CLAUDE_CONFIG_DIR to a short label for its Claude account.
# For consumer email (gmail/yahoo/etc), use local-part. Otherwise use the domain stem
# (e.g. cloud@optimchain.org -> "optimchain") so org-shared mailboxes show the org.
account_label() {
  local ccd="$1"
  [[ -n "$ccd" && -f "$ccd/.claude.json" ]] || { echo "—"; return; }
  local email
  email=$(/opt/anaconda3/bin/jq -r '.oauthAccount.emailAddress // .emailAddress // empty' "$ccd/.claude.json" 2>/dev/null)
  [[ -z "$email" ]] && { echo "—"; return; }
  local local_part="${email%%@*}" domain="${email##*@}"
  case "$domain" in
    gmail.com|yahoo.com|hotmail.com|outlook.com|icloud.com|protonmail.com|pm.me|proton.me)
      echo "$local_part" ;;
    *)
      echo "${domain%%.*}" ;;
  esac
}

# Discover bots: each entry is "bot_id|workdir|token|username|account".
discover_bots() {
  for dir in $WORKDIR_GLOB; do
    [[ -d "$dir" ]] || continue
    local env="$dir/.env"
    local db="$dir/data/bot.db"
    [[ -f "$env" && -f "$db" ]] || continue
    local token claude_dir
    token=$(/usr/bin/grep -E '^TELEGRAM_BOT_TOKEN=' "$env" | head -1 | cut -d= -f2-)
    claude_dir=$(/usr/bin/grep -E '^CLAUDE_CONFIG_DIR=' "$env" | head -1 | cut -d= -f2-)
    [[ -n "$token" ]] || continue
    local bot_id="${token%%:*}"
    local username
    username=$(/usr/bin/curl -fsS --max-time 5 \
                 "https://api.telegram.org/bot${token}/getMe" 2>/dev/null \
                 | /opt/anaconda3/bin/jq -r '.result.username // empty' 2>/dev/null)
    [[ -z "$username" ]] && username="bot_${bot_id}"
    local account
    account=$(account_label "$claude_dir")
    printf '%s|%s|%s|%s|%s\n' "$bot_id" "$dir" "$token" "$username" "$account"
  done
}

check_process() {
  local db="$1/data/bot.db"
  [[ -f "$db" ]] || return 1
  local pids
  pids=$(/usr/sbin/lsof -t -- "$db" 2>/dev/null | head -1)
  [[ -n "$pids" ]]
}

check_api() {
  local token="$1"
  local body
  body=$(/usr/bin/curl -fsS --max-time 10 "https://api.telegram.org/bot${token}/getMe" 2>/dev/null) || return 1
  [[ "$body" == *'"ok":true'* ]]
}

# Collect all known tokens for fallback alert routing — captured before any iteration.
ALL_TOKENS=()

send_alert() {
  local text="$1"
  for tok in "${ALL_TOKENS[@]}"; do
    if /usr/bin/curl -fsS --max-time 10 \
        --data-urlencode "chat_id=${ALERT_CHAT_ID}" \
        --data-urlencode "text=${text}" \
        "https://api.telegram.org/bot${tok}/sendMessage" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

should_alert() {
  local id="$1" reason="$2"
  local marker="$STATE_DIR/${id}.down"
  if [[ -f "$marker" ]]; then
    local prev; prev=$(cat "$marker" 2>/dev/null)
    [[ "$prev" == "$reason" ]] && return 1
  fi
  printf '%s' "$reason" > "$marker"
  return 0
}

mark_up() {
  local id="$1"
  local marker="$STATE_DIR/${id}.down"
  if [[ -f "$marker" ]]; then
    rm -f "$marker"
    return 0
  fi
  return 1
}

BOTS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && BOTS+=("$line")
done < <(discover_bots)
if [[ ${#BOTS[@]} -eq 0 ]]; then
  log "ERROR no bots discovered under $WORKDIR_GLOB"
  exit 1
fi
for entry in "${BOTS[@]}"; do
  ALL_TOKENS+=("$(echo "$entry" | cut -d'|' -f3)")
done

any_failure=0
STATUS_ROWS=()  # one row per bot for the heartbeat body

for entry in "${BOTS[@]}"; do
  IFS='|' read -r bot_id workdir token username account <<< "$entry"
  display="@${username}"

  reasons=()
  check_process "$workdir" || reasons+=("process not running")
  check_api "$token"       || reasons+=("Telegram API unreachable")

  pid=$(/usr/sbin/lsof -t -- "$workdir/data/bot.db" 2>/dev/null | head -1)

  if [[ ${#reasons[@]} -eq 0 ]]; then
    STATUS_ROWS+=("$(printf '%-22s %-7s %-22s OK' "$display" "${pid:--}" "$account")")
    if mark_up "$bot_id"; then
      log "RECOVER ${display}"
      send_alert "✅ ${display} recovered" || log "ALERT-FAIL ${display} recovery"
    else
      log "OK ${display}"
    fi
  else
    any_failure=1
    reason_str="${reasons[*]}"
    STATUS_ROWS+=("$(printf '%-22s %-7s %-22s DOWN: %s' "$display" "${pid:--}" "$account" "$reason_str")")
    if should_alert "$bot_id" "$reason_str"; then
      log "DOWN ${display}: $reason_str"
      send_alert "🔴 ${display} down: ${reason_str}" || log "ALERT-FAIL ${display} down"
    else
      log "STILL-DOWN ${display}: $reason_str"
    fi
  fi
done

# Heartbeat (dead-man's switch + fleet status body). Only fires if HEALTHCHECKS_URL is set.
if [[ -n "${HEALTHCHECKS_URL:-}" ]]; then
  body=$(
    printf 'Stephanie bot fleet — %s\n' "$(ts)"
    printf 'host: %s\n\n' "$(hostname -s)"
    printf '%-22s %-7s %-22s %s\n' "Bot" "PID" "Account" "Status"
    printf '%-22s %-7s %-22s %s\n' "----------------------" "-------" "----------------------" "------"
    for row in "${STATUS_ROWS[@]}"; do printf '%s\n' "$row"; done
  )
  url="$HEALTHCHECKS_URL"
  [[ $any_failure -ne 0 ]] && url="${HEALTHCHECKS_URL}/fail"
  if ! /usr/bin/curl -fsS --max-time 10 --retry 2 \
        -H 'Content-Type: text/plain; charset=utf-8' \
        --data-binary "$body" \
        "$url" >/dev/null 2>&1; then
    log "HEARTBEAT-FAIL"
  fi
fi
