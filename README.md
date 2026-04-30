distributed_stephanie_bots

## Install on a new Mac

```bash
brew install gh jq tailscale
git clone https://github.com/stephanieisapenguin/stephanie_swarm.git ~/stephanie_swarm
mkdir -p ~/bin ~/.config ~/Library/LaunchAgents
install -m 755 ~/stephanie_swarm/bin/stephanie-uptime.sh           ~/bin/
install -m 755 ~/stephanie_swarm/bin/stephanie-uptime-gist-push.sh ~/bin/
install -m 755 ~/stephanie_swarm/bin/stephanie-mapping-push.sh     ~/bin/
cp ~/stephanie_swarm/LaunchAgents/com.jasonzb.stephanie-uptime.plist      ~/Library/LaunchAgents/
cp ~/stephanie_swarm/LaunchAgents/com.jasonzb.stephanie-uptime-gist.plist ~/Library/LaunchAgents/
echo 'HEALTHCHECKS_URL=https://hc-ping.com/<paste-uuid>' > ~/.config/stephanie-uptime.conf
chmod 600 ~/.config/stephanie-uptime.conf
gh auth login --hostname github.com --git-protocol https --web --scopes gist
```

Per-bot setup (one time, per bot you want to run):

```bash
BOT=stephanie_X
mkdir -p /Users/$USER/claude-code-telegram-$BOT/data
cat > /Users/$USER/claude-code-telegram-$BOT/.env <<'EOF'
TELEGRAM_BOT_TOKEN=<from BotFather>
TELEGRAM_BOT_USERNAME=<bot username>
APPROVED_DIRECTORY=/Users/<you>
ALLOWED_USERS=
CLAUDE_CONFIG_DIR=/Users/<you>/.claude-<account-slot>
EOF
chmod 600 /Users/$USER/claude-code-telegram-$BOT/.env
CLAUDE_CONFIG_DIR=/Users/$USER/.claude-<account-slot> claude  # then /login
```

## Tailscale (remote ops)

```bash
sudo brew services start tailscale
sudo tailscale up --ssh --operator=$USER
tailscale status
```

## Restart the stack

```bash
for d in /Users/jasonzb/claude-code-telegram*/; do
  d="${d%/}"; [ -f "$d/.env" ] || continue
  lsof -t "$d/data/bot.db" >/dev/null 2>&1 || (cd "$d" && nohup /Users/jasonzb/.local/bin/claude-telegram-bot >> bot.log 2>&1 < /dev/null &)
done
launchctl load -w ~/Library/LaunchAgents/com.jasonzb.stephanie-uptime.plist 2>/dev/null
launchctl load -w ~/Library/LaunchAgents/com.jasonzb.stephanie-uptime-gist.plist 2>/dev/null
```
