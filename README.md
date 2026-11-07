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

## Rotating bot profile photos (opt-in, per bot)

`bin/stephanie-bot-avatar.py` changes a bot's Telegram profile photo once a
week. It picks from local images or from a Telegram sticker set. A launchd job
runs it every 6h, and each bot rotates at most once per period, so it catches
up after sleep or a reboot.

A bot token **cannot** change a bot's own photo. The script logs in as the
bot's **owner** user account (the one that created the bot in BotFather) and
calls `photos.uploadProfilePhoto(bot=...)`.

One-time machine setup:

```bash
python3 -m venv ~/.venvs/stephanie-avatar
~/.venvs/stephanie-avatar/bin/pip install telethon pillow
install -m 755 ~/stephanie_swarm/bin/stephanie-bot-avatar.py ~/bin/
mkdir -p ~/.config/stephanie-avatar && chmod 700 ~/.config/stephanie-avatar
cat > ~/.config/stephanie-avatar.conf <<'EOF'
TG_API_ID=<from https://my.telegram.org → API development tools>
TG_API_HASH=<...>
TG_SESSION=/Users/<you>/.config/stephanie-avatar/owner
EOF
chmod 600 ~/.config/stephanie-avatar.conf
~/.venvs/stephanie-avatar/bin/python ~/bin/stephanie-bot-avatar.py --login   # phone, code, 2FA
cp ~/stephanie_swarm/LaunchAgents/com.jasonzb.stephanie-bot-avatar.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.jasonzb.stephanie-bot-avatar.plist
```

Turn it on for a bot by adding these lines to that bot's `.env`. For example, `@stephanie_2_bot`:

```bash
AVATAR_ROTATE=1
AVATAR_SOURCE=local            # local | telegram | both (local falls back to telegram if no images)
AVATAR_DIR=/Users/<you>/claude-code-telegram-stephanie_2/avatars   # default: <workdir>/avatars
AVATAR_STICKER_SET=<short name from t.me/addstickers/<name>>        # optional
AVATAR_INTERVAL_DAYS=7
AVATAR_KEEP_HISTORY=0          # 0 deletes the previous rotated photo
```

Drop `.jpg`/`.png`/`.webp` files into `AVATAR_DIR`. The script walks through
them in filename order, one per week. Only static (webp) stickers are used;
animated and video stickers are skipped. Bots without `AVATAR_ROTATE=1` are
never touched.

```bash
PY=~/.venvs/stephanie-avatar/bin/python
$PY ~/bin/stephanie-bot-avatar.py --dry-run                       # what would change
$PY ~/bin/stephanie-bot-avatar.py --bot stephanie_2_bot --force   # rotate now
tail -f ~/Library/Logs/stephanie-bot-avatar.log
```

The script keeps per-bot state in `<workdir>/.avatar_state.json` and
converted images in `<workdir>/.avatar_cache/`. Both are gitignored, as is
`*.session`. Keep the session file private: it is a full login to the
owner's Telegram account.

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
