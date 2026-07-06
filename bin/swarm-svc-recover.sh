#!/bin/bash
# swarm-svc-recover — health-driven process recovery for the swarm services.
#
# launchd's KeepAlive restarts crashed processes; this catches what it can't:
# hung processes that still hold the port, a wedged ollama, or a cloudflared
# tunnel that silently died. Only services whose launchd plist is installed
# are managed — ad-hoc (nohup/terminal) processes are treated as dev mode and
# left alone, so running this on a machine without plists is a no-op.
#
# Usage:
#   bin/swarm-svc-recover.sh                     probe + bounce anything unhealthy
#   bin/swarm-svc-recover.sh --dry-run           print what would happen, change nothing
#   bin/swarm-svc-recover.sh --install-watchdog  install a launchd timer running this
#                                                every 5 min (logs: services/recovery.log)
#   bin/swarm-svc-recover.sh --uninstall-watchdog
set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICES_DIR="$REPO_DIR/services"
LA="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

WATCHDOG_LABEL="com.${USER}.swarm-svc.watchdog"

if [ "${1:-}" = "--install-watchdog" ]; then
  plist="$LA/${WATCHDOG_LABEL}.plist"
  mkdir -p "$LA"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${WATCHDOG_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${REPO_DIR}/bin/swarm-svc-recover.sh</string>
    </array>
    <key>StartInterval</key><integer>300</integer>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>${SERVICES_DIR}/recovery.log</string>
    <key>StandardErrorPath</key><string>${SERVICES_DIR}/recovery.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>${HOME}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF
  launchctl bootout "gui/${UID_NUM}/${WATCHDOG_LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/${UID_NUM}" "$plist"
  echo "watchdog installed + loaded (every 300s) — $plist"
  exit 0
fi

if [ "${1:-}" = "--uninstall-watchdog" ]; then
  launchctl bootout "gui/${UID_NUM}/${WATCHDOG_LABEL}" 2>/dev/null || true
  rm -f "$LA/${WATCHDOG_LABEL}.plist"
  echo "watchdog removed"
  exit 0
fi

echo "swarm-svc-recover @ $(date '+%Y-%m-%d %H:%M:%S')"
bounced=0

act() {  # act <label> <reason>
  if [ "$DRY" = 1 ]; then
    echo "  [dry-run] would kickstart $1 ($2)"
  else
    echo "  bouncing $1 ($2)"
    launchctl kickstart -k "gui/${UID_NUM}/$1" 2>/dev/null \
      || launchctl bootstrap "gui/${UID_NUM}" "$LA/$1.plist" 2>/dev/null \
      || echo "  !! could not kickstart $1"
    bounced=$((bounced+1))
  fi
}

healthy_http() { curl -s --max-time 4 "$1" | grep -q '"ok"'; }

check_http_svc() {  # check_http_svc <name> <health-url>
  local label="com.${USER}.swarm-svc.$1"
  [ -f "$LA/${label}.plist" ] || { echo "  - $1: not installed here, skipping"; return; }
  if healthy_http "$2"; then
    echo "  ✓ $1 healthy"
  else
    act "$label" "health probe failed: $2"
  fi
}

# ollama first — compute is only as alive as its model server.
if [ -f "$LA/com.${USER}.swarm-svc.compute.plist" ]; then
  if curl -s --max-time 4 "http://localhost:11434/api/tags" >/dev/null 2>&1; then
    echo "  ✓ ollama healthy"
  elif [ "$DRY" = 1 ]; then
    echo "  [dry-run] would restart ollama"
  else
    echo "  restarting ollama"
    brew services restart ollama >/dev/null 2>&1 || true
    bounced=$((bounced+1))
  fi
fi

check_http_svc compute  "http://localhost:${COMPUTE_PORT:-8878}/health"
check_http_svc dispatch "http://localhost:${DISPATCH_PORT:-8877}/health"
check_http_svc frontend "http://localhost:${FRONTEND_PORT:-8879}/health"

# tunnel has no local HTTP surface — recover on missing process.
tunnel_label="com.${USER}.swarm-svc.tunnel"
if [ -f "$LA/${tunnel_label}.plist" ]; then
  if pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
    echo "  ✓ tunnel process present"
  else
    act "$tunnel_label" "no cloudflared process"
  fi
fi

if [ "$bounced" -gt 0 ] && [ "$DRY" = 0 ]; then
  sleep 5
  echo "post-recovery status:"
  "$REPO_DIR/bin/swarm-check.sh" || true
fi
echo "recover done — $bounced action(s)"
