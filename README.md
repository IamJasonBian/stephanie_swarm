distributed_stephanie_bots

## Install on a new Mac

```bash
brew install gh jq tailscale
git clone https://github.com/stephanieisapenguin/stephanie_swarm.git ~/stephanie_swarm
mkdir -p ~/bin ~/.config ~/Library/LaunchAgents
install -m 755 ~/stephanie_swarm/bin/stephanie-uptime.sh             ~/bin/
install -m 755 ~/stephanie_swarm/bin/stephanie-uptime-gist-push.sh   ~/bin/
install -m 755 ~/stephanie_swarm/bin/stephanie-mapping-push.sh       ~/bin/
install -m 755 ~/stephanie_swarm/bin/stephanie-bot-launcher.sh       ~/bin/
install -m 755 ~/stephanie_swarm/bin/stephanie-bots-plists-install.sh ~/bin/
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

## MCP servers

```bash
mkdir -p ~/.config/stephanie-network ~/mcp-servers/stephanie-network
cp ~/stephanie_swarm/config/mcp.json ~/.config/stephanie-network/mcp.json
cp ~/stephanie_swarm/mcp-servers/stephanie-network/server.py ~/mcp-servers/stephanie-network/server.py
```
The `mcp.json` paths assume the upstream `claude-code-telegram` source repo is at `/Users/<you>/claude-code-telegram/` and its Poetry venv exists. If venv path or username differs, edit `~/.config/stephanie-network/mcp.json`.

## Tailscale (remote ops)

```bash
sudo brew services start tailscale
sudo tailscale up --ssh --operator=$USER
tailscale status
```

## Tier 1 uptime config

```bash
sudo pmset -a sleep 0 disksleep 0 powernap 0 autorestart 1
sudo pmset repeat wakeorpoweron MTWRFSU 03:00:00
```
Also enable Automatic Login (System Settings → Users & Groups → Login Options) and disable forced macOS updates (System Settings → Software Update → Advanced).

## Restart the stack (rerun-safe)

```bash
~/bin/stephanie-bots-plists-install.sh
for plist in ~/Library/LaunchAgents/com.jasonzb.stephanie-{uptime,uptime-gist,bot.*}.plist; do
  launchctl load -w "$plist" 2>/dev/null
done
```
