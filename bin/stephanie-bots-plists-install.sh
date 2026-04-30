#!/bin/bash
# Generate one launchd plist per discovered stephanie bot working dir.
# Idempotent: re-run when bots are added/removed.

set -eu

WORKDIR_GLOB="/Users/jasonzb/claude-code-telegram*"
LAUNCHER="/Users/jasonzb/bin/stephanie-bot-launcher.sh"
LA="$HOME/Library/LaunchAgents"

mkdir -p "$LA"

for d in $WORKDIR_GLOB; do
  [[ -d "$d" && -f "$d/.env" ]] || continue
  name=$(basename "$d")
  label="com.jasonzb.stephanie-bot.${name}"
  plist="$LA/${label}.plist"

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${label}</string>
    <key>WorkingDirectory</key><string>${d}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${LAUNCHER}</string>
        <string>${d}</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>StandardOutPath</key><string>${d}/bot.log</string>
    <key>StandardErrorPath</key><string>${d}/bot.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/Users/jasonzb/.local/bin:/opt/homebrew/bin:/opt/anaconda3/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF
  echo "wrote $plist"
done
