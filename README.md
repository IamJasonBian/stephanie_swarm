## _____

distributed_stephanie_bots

@stephanie_penguin_bot - telegram bot leadernode

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

### nyc-tow-finder

Exposes NYC's public "Find Your Towed Vehicle" lookup as MCP tools
(`find_towed_vehicle`, `list_states`, `list_plate_types`). See
[`mcp-servers/nyc-tow-finder/README.md`](mcp-servers/nyc-tow-finder/README.md)
for how it bypasses the site's Akamai bot protection (`curl_cffi` TLS
impersonation) and reconstructs the NYCSERV pipe-protocol.

```bash
mkdir -p ~/mcp-servers/nyc-tow-finder
cp ~/stephanie_swarm/mcp-servers/nyc-tow-finder/*.py           ~/mcp-servers/nyc-tow-finder/
cp ~/stephanie_swarm/mcp-servers/nyc-tow-finder/reference.json ~/mcp-servers/nyc-tow-finder/
pip install "mcp[cli]" curl_cffi   # into the interpreter mcp.json points at
```

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

## Remote tasks (headless Claude, survives the laptop sleeping)
`bin/remote-task.sh` runs one supervised `claude -p` task detached on this node: fresh clone
into `~/work/<job>`, allow-listed tools (read/edit, git, `gh pr`, tests; no merge/deploy),
resumed with `--continue` until an optional done-check passes, `DEADLINE_SECS` (7200) or
`MAX_PASSES` (10). Logs, brief and status land in `~/work/logs/remote-tasks/<job>/`; the clone
is removed at the end only if every branch is pushed and the tree is clean.

```bash
# from the laptop
scp brief.md coach-in-a-cave:~/work/my-job-brief.md
ssh coach-in-a-cave 'nohup ~/stephanie_swarm/bin/remote-task.sh my-job IamJasonBian/allocation-engine-2.0 \
  ~/work/my-job-brief.md "gh pr list --repo IamJasonBian/allocation-engine-2.0 --head my-branch --state open --json number -q length | grep -qv ^0$" \
  >/dev/null 2>&1 </dev/null & disown'

ssh coach-in-a-cave '~/stephanie_swarm/bin/remote-task-status.sh my-job'     # status
ssh coach-in-a-cave 'tail -f ~/work/logs/remote-tasks/my-job/my-job.log'     # raw stream-json
ssh coach-in-a-cave 'pkill -f "remote-task.sh my-job"'                       # stop
```
Never restart the swarm launchd services to stop a task — kill the task by its job name.
