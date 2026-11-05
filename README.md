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

## Running agent jobs on raw VMs (`bin/swarm-vm`)

Handoff-style jobs (`claude -p`, Devin, anything) over ssh — nothing to install on
the VM, `swarm-vm` pipes itself over `ssh host python3 -`. Each job runs under a
small supervisor that owns its pids, logs and spend:

```bash
echo 'vm1' >> ~/.config/swarm-vm/hosts          # or -H vm1 / $SWARM_VM_HOSTS
# VM: API key lives in ~/.swarm-vm/env (chmod 600), never in argv or ssh history
bin/swarm-vm -H vm1 start --name fix-bug --budget-usd 2 --ttl 3600 -- \
    claude -p "fix the failing test" --output-format stream-json --verbose
bin/swarm-vm ls          # every host: pid, procs, rss, age, cost, tokens
bin/swarm-vm -H vm1 logs <id> -n 50
bin/swarm-vm -H vm1 kill <id>
bin/swarm-vm spend       # per host + fleet, today (UTC)
bin/swarm-vm reap        # put in cron: kills verified orphans, prunes old runs, caps disk
```

- **pids** — own session per job; identity = pid + `/proc` start time (no recycled-pid
  kills); kills the whole process group; leftover grandchildren are swept when the job
  exits; a dead supervisor is detected (`orphan`) and reaped. `--max-procs N` /
  `--max-rss-mb N` kill a runaway group (fork bomb, leak); off by default.
- **logs** — through the supervisor, not a shell redirect: size-capped with rotation
  (`--max-log-mb`, default 64), newline-free floods bounded, secrets (env values named
  `*KEY*/*TOKEN*/*SECRET*`, `sk-…`, `Bearer …`, `ghp_…`) redacted. `~/.swarm-vm/env`
  must be `chmod 600` or `start` refuses.
- **spend** — metered live from stream-json usage / `total_cost_usd`, per `session_id`
  and summed (wrappers that run several `claude -p` calls count in full). Killed on
  `--budget-usd`, `--budget-tokens` (cache reads excluded — they re-count the whole
  context every turn), `--ttl` (default 1h), or the VM daily cap `SWARM_VM_DAILY_USD`
  (checked every 5s). `SWARM_VM_FLEET_USD` refuses new starts fleet-wide (warns when a
  host is unreachable; `SWARM_VM_FLEET_STRICT=1` refuses instead). Orphaned/lost runs
  still count toward the day's spend.
  Mid-run USD is an estimate: set `SWARM_VM_PRICE_IN/_OUT` (USD per M tokens) on the VM
  (cache write/read priced at 1.25×/0.1× input, override `SWARM_VM_CACHE_WRITE_X/_READ_X`);
  otherwise only token budgets bite until the final `result` line reports real cost.
  `claude` needs `--output-format stream-json --verbose` or budgets can't bite mid-run
  (`start` warns). Subscription (chat-login) runs report notional cost. Days are UTC.

Tests: `python3 -m unittest tests.test_swarm_vm -v` (~25s, real processes).
