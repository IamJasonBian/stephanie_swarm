#!/bin/bash
# swarm-check — one command to verify connectivity to the swarm services.
#
# Usage:
#   swarm-check.sh                    check localhost + public link
#   swarm-check.sh <dispatch-url>     check a specific hub (e.g. a tailscale host)
#   DISPATCH_URL=... swarm-check.sh   same, via env
#
# Exit code 0 = dispatch reachable and at least one model backend ready.
set -u

DISPATCH="${1:-${DISPATCH_URL:-http://localhost:8877}}"
COMPUTE="${COMPUTE_URL:-http://localhost:8878}"
PUBLIC="${PUBLIC_URL:-https://hermes-chat.hermes-swarm.workers.dev}"

pass=0; fail=0
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; pass=$((pass+1)); }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; fail=$((fail+1)); }
get()  { curl -s --max-time "${2:-5}" "$1" 2>/dev/null; }

echo "swarm-check @ $(date '+%H:%M:%S')"

# ---- local node --------------------------------------------------------
echo "local node:"
if get "$COMPUTE/health" >/dev/null; then
  H=$(get "$COMPUTE/health")
  ok "compute $COMPUTE"
  echo "$H" | grep -q '"reachable":true' && ok "ollama/hermes model loaded" || bad "hermes model not reachable (ollama pull hermes3:8b?)"
  echo "$H" | python3 -c "
import json,sys
b=json.load(sys.stdin)['backends']
print('    claude:', 'ready' if b['claude']['ready'] else 'no key (set ANTHROPIC_API_KEY or CLAUDE_BACKEND=cli)')
print('    kimi:  ', 'ready' if b['kimi']['ready'] else 'no key (set OPENROUTER_API_KEY)')
print('    judge0:', 'configured' if b['judge0']['configured'] else 'not configured')
print('    docling:', 'ready' if b['converter']['ready'] else 'missing venv')" 2>/dev/null
else
  bad "compute $COMPUTE (not running here — fine for a non-worker machine)"
fi

# ---- main service (dispatch hub) ---------------------------------------
echo "main service:"
D=$(get "$DISPATCH/health" 8)
if [ -n "$D" ]; then
  ok "dispatch $DISPATCH"
  echo "$D" | python3 -c "
import json,sys
d=json.load(sys.stdin)
p=d.get('pool',{})
print(f\"    compute pool: {p.get('healthy','?')}/{p.get('total','?')} nodes healthy\")
q=d.get('queue',{})
print(f\"    queue: {q.get('queued',0)} queued, running {q.get('running',{})}\")" 2>/dev/null
  echo "$D" | grep -q '"ok":true' && ok "at least one model backend ready" || bad "no healthy backends behind dispatch"
else
  bad "dispatch $DISPATCH unreachable"
fi

# ---- public link --------------------------------------------------------
echo "public link:"
P=$(get "$PUBLIC/api/health" 10)
if [ -n "$P" ]; then
  echo "$P" | grep -q '"ok":true' \
    && ok "$PUBLIC (worker + tunnel + dispatch all up)" \
    || bad "$PUBLIC responds but tunnel/dispatch is down behind it"
else
  bad "$PUBLIC unreachable"
fi

echo "result: $pass ok, $fail failed"
[ -n "$D" ] && echo "$D" | grep -q '"ok":true'
