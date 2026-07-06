#!/bin/bash
# Generate + (re)load launchd plists for the swarm services stack:
# compute (:8878), dispatch (:8877), and the cloudflared tunnel.
# Idempotent — re-run any time; launchd restarts crashed services
# (KeepAlive) and picks them up at login (RunAtLoad).
#
# Usage:
#   bin/swarm-svc-plists-install.sh                  install/reload all three (hub)
#   bin/swarm-svc-plists-install.sh --only compute   worker node: just compute
#   bin/swarm-svc-plists-install.sh --no-load        write plists only
#   bin/swarm-svc-plists-install.sh --uninstall      boot out + remove plists
#
# NOTE: if the services are already running ad-hoc (nohup/terminal), kill
# them first or launchd will crash-loop on the busy ports:
#   lsof -ti:8877 -ti:8878 | xargs kill
set -eu

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICES_DIR="$REPO_DIR/services"
LAUNCHER="$REPO_DIR/bin/swarm-svc-launcher.sh"
LA="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
MODE="${1:-}"
SERVICES="compute dispatch tunnel frontend"
if [ "$MODE" = "--only" ]; then
  SERVICES="${2:?usage: --only <compute|dispatch|tunnel>}"
  MODE=""
fi

mkdir -p "$LA"

for what in $SERVICES; do
  label="com.${USER}.swarm-svc.${what}"
  plist="$LA/${label}.plist"

  if [ "$MODE" = "--uninstall" ]; then
    launchctl bootout "gui/${UID_NUM}/${label}" 2>/dev/null || true
    rm -f "$plist"
    echo "removed $label"
    continue
  fi

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${LAUNCHER}</string>
        <string>${SERVICES_DIR}</string>
        <string>${what}</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>15</integer>
    <key>StandardOutPath</key><string>${SERVICES_DIR}/${what}.log</string>
    <key>StandardErrorPath</key><string>${SERVICES_DIR}/${what}.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>${HOME}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF
  echo "wrote $plist"

  if [ "$MODE" != "--no-load" ]; then
    launchctl bootout "gui/${UID_NUM}/${label}" 2>/dev/null || true
    launchctl bootstrap "gui/${UID_NUM}" "$plist"
    echo "loaded $label"
  fi
done
