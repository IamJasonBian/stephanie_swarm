#!/bin/bash
# Pushes the latest stephanie-uptime log to a public gist so a remote agent can audit it.
# Owner of the gist is `stephanieisapenguin` — uses gh keyring token for that account.

set -u

GIST_ID="6944ac3b7c93b7d25cba18f27f33b73b"
LOG="$HOME/Library/Logs/stephanie-uptime.log"
GH_BIN="/opt/homebrew/bin/gh"
JQ_BIN="/opt/anaconda3/bin/jq"
GIST_FILENAME="stephanie-uptime.log"
PUSH_LOG="$HOME/Library/Logs/stephanie-uptime-gist.log"

ts() { date "+%Y-%m-%dT%H:%M:%S%z"; }
plog() { printf '%s %s\n' "$(ts)" "$*" >> "$PUSH_LOG"; }

[[ -f "$LOG" ]] || { plog "no log file"; exit 0; }

# Cap at 5000 lines to keep gist size reasonable. ~80 days at 1/min, well under GitHub's 1MB/file gist limit.
CONTENT=$(/usr/bin/tail -n 5000 "$LOG")
TOKEN=$("$GH_BIN" auth token -u stephanieisapenguin 2>/dev/null) || { plog "no token"; exit 1; }

PAYLOAD=$("$JQ_BIN" -n --arg name "$GIST_FILENAME" --arg content "$CONTENT" \
  '{files: {($name): {content: $content}}}')

HTTP=$(/usr/bin/curl -sS -o /tmp/stephanie-gist-push.out -w '%{http_code}' \
  -X PATCH "https://api.github.com/gists/${GIST_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  --data-binary "$PAYLOAD" 2>&1) || { plog "curl failed"; exit 1; }

if [[ "$HTTP" == "200" ]]; then
  plog "OK pushed $(echo "$CONTENT" | wc -l | tr -d ' ') lines"
else
  plog "FAIL http=$HTTP body=$(/usr/bin/head -c 400 /tmp/stephanie-gist-push.out)"
  exit 1
fi

# Refresh the topology mapping in the same gist (cheap, keeps it in sync as bots come/go).
if [[ -x "$HOME/bin/stephanie-mapping-push.sh" ]]; then
  if ! "$HOME/bin/stephanie-mapping-push.sh" >/tmp/stephanie-mapping-out 2>&1; then
    plog "MAPPING-FAIL $(head -c 200 /tmp/stephanie-mapping-out)"
  fi
fi
