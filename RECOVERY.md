# Stephanie Bot Stack — Recovery Handbook

When something breaks, this is the playbook. Find the symptom, run the diagnosis, apply the fix.

## What "healthy" looks like

```bash
launchctl list | grep stephanie
# expect: 6 bot jobs + com.jasonzb.stephanie-uptime + com.jasonzb.stephanie-uptime-gist (8 lines)

for d in /Users/jasonzb/claude-code-telegram*/; do
  pid=$(lsof -t "${d}data/bot.db" 2>/dev/null | head -1)
  printf '%s pid=%s\n' "$d" "${pid:-NONE}"
done
# expect: every dir has a non-empty pid

tail -8 ~/Library/Logs/stephanie-uptime.log
# expect: 6 OK lines per minute, no DOWN/STILL-DOWN/HEARTBEAT-FAIL
```

Healthchecks dashboard should be green: https://healthchecks.io/checks/cac90552-e328-4ed2-b9a3-e6afb470bec4/details/

---

## Get into the Mac when off-site

```bash
# from phone or any other tailnet device:
ssh jasonzb@jasons-mbp-2.tailcd3237.ts.net
```

If Tailscale SSH is down (Mac frozen, network out): power-cycle via the smart plug from your phone, then SSH back in once the Mac is up again. `pmset autorestart 1` brings the Mac up automatically when power returns.

---

## Symptom → Fix

### "🔴 @<bot> down: Telegram API unreachable"

Network blip. Almost always self-heals within 1-2 ticks → expect a "✅ recovered" within 2 minutes. If it persists >5 minutes:

```bash
curl -sS https://api.telegram.org/bot<TOKEN>/getMe   # use a token from any bot's .env
ping -c 3 1.1.1.1                                    # is internet up at all?
tailscale status                                     # is tailnet up?
```

### "🔴 @<bot> down: process not running"

KeepAlive should restart it within ~30s (ThrottleInterval). If "✅ recovered" doesn't follow within 1 minute:

```bash
WORKDIR=/Users/jasonzb/claude-code-telegram-<name>
launchctl kickstart -k gui/$(id -u)/com.jasonzb.stephanie-bot.$(basename "$WORKDIR")
sleep 5
lsof -t "$WORKDIR/data/bot.db"                       # should print a PID
tail -50 "$WORKDIR/bot.log"                          # diagnose what killed it
```

### Healthchecks alert (red on dashboard / pings stopped)

Means the Mac is off, network is dead, OR the monitor itself crashed. SSH in:

```bash
launchctl list | grep stephanie-uptime
# if missing:
launchctl load -w ~/Library/LaunchAgents/com.jasonzb.stephanie-uptime.plist

# manual single tick to send a heartbeat now:
~/bin/stephanie-uptime.sh
```

### Mac frozen, Tailscale SSH unresponsive

1. Power-cycle via smart plug from your phone.
2. Wait ~2 min for boot + Tailscale daemon + launchd jobs.
3. SSH in. Verify with the "what healthy looks like" block.

If no smart plug, hard reboot in person (power button 10s).

### Mac rebooted, things look weird after

```bash
launchctl list | grep stephanie    # expect 8 jobs
# if any missing, run the rerun-safe restart block:
~/bin/stephanie-bots-plists-install.sh
for plist in ~/Library/LaunchAgents/com.jasonzb.stephanie-{uptime,uptime-gist,bot.*}.plist; do
  launchctl load -w "$plist" 2>/dev/null
done
```

### Bot crash-looping (lots of DOWN/RECOVER cycles, or many STARTEDs in launchd.log)

```bash
NAME=<workdir-basename>
tail -200 /Users/jasonzb/$NAME/bot.log
launchctl print gui/$(id -u)/com.jasonzb.stephanie-bot.$NAME | head -40
```

Common causes:
- Malformed `.env` (recently edited, syntax issue)
- Telegram token revoked at BotFather
- `CLAUDE_CONFIG_DIR` points at a deleted/unauth'd config dir
- Disk full (`df -h ~`)

### Claude rate-limit errors in a bot's log

Multiple bots share a Claude account. Check the mapping at https://gist.github.com/stephanieisapenguin/6944ac3b7c93b7d25cba18f27f33b73b — see the "CLAUDE_CONFIG_DIR" column. Mitigations:

- Move a bot to the less-busy Claude account: edit its `.env` `CLAUDE_CONFIG_DIR=...`, restart bot, ensure that config dir has been `/login`'d.
- Wait for rate limit reset (usually hourly).

### Lots of `Telegram API unreachable` over a short window

Network issue. Check WiFi → ethernet path:

```bash
networksetup -listallhardwareports
ifconfig en0 | grep inet         # primary network IP
ping -c 3 api.telegram.org
```

If you have a USB-C ethernet dongle, plug it in — wired removes most of these.

### `HEARTBEAT-FAIL` lines in the uptime log

Healthchecks.io is unreachable from the Mac (rare) OR the URL is wrong:

```bash
cat ~/.config/stephanie-uptime.conf
curl -fsS https://hc-ping.com/cac90552-e328-4ed2-b9a3-e6afb470bec4
# should print "OK"
```

### Adding a new bot

See [README.md](README.md) "Per-bot setup". After:

```bash
~/bin/stephanie-bots-plists-install.sh
launchctl load -w ~/Library/LaunchAgents/com.jasonzb.stephanie-bot.<name>.plist
```

Monitor + mapping pick it up automatically on next tick / next 10-min push.

### Removing a bot

```bash
NAME=<workdir-basename>
launchctl bootout gui/$(id -u)/com.jasonzb.stephanie-bot.$NAME
rm ~/Library/LaunchAgents/com.jasonzb.stephanie-bot.$NAME.plist
mv /Users/jasonzb/$NAME /Users/jasonzb/_archived-$NAME    # rename so glob skips
# optional: /revoke the bot token via @BotFather
```

### Rotating a Telegram token

```bash
NAME=<workdir-basename>
# 1. /revoke via @BotFather, copy new token
# 2. edit .env:
sed -i '' "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=<new-token>|" /Users/jasonzb/$NAME/.env
# 3. restart bot
launchctl kickstart -k gui/$(id -u)/com.jasonzb.stephanie-bot.$NAME
```

### Re-authenticating a Claude account

```bash
CLAUDE_CONFIG_DIR=/Users/jasonzb/.claude-stephanie<N> claude
# /login → finish OAuth in browser → /quit
```

All bots sharing that `CLAUDE_CONFIG_DIR` pick up the new auth on their next Claude subprocess call. No bot restart needed.

---

## "I have no idea what's wrong" — full reset

```bash
# 1. SSH in via Tailscale
ssh jasonzb@jasons-mbp-2.tailcd3237.ts.net

# 2. Pause everything
launchctl unload ~/Library/LaunchAgents/com.jasonzb.stephanie-uptime.plist 2>/dev/null
for plist in ~/Library/LaunchAgents/com.jasonzb.stephanie-bot.*.plist; do
  launchctl bootout gui/$(id -u)/$(basename "$plist" .plist) 2>/dev/null
done

# 3. Verify everything is dead
lsof /Users/jasonzb/claude-code-telegram*/data/bot.db 2>/dev/null
launchctl list | grep stephanie

# 4. Bring it all back
~/bin/stephanie-bots-plists-install.sh
for plist in ~/Library/LaunchAgents/com.jasonzb.stephanie-{uptime,uptime-gist,bot.*}.plist; do
  launchctl load -w "$plist"
done
sleep 10

# 5. Verify healthy
launchctl list | grep stephanie    # 8 lines
~/bin/stephanie-uptime.sh           # should log 6 OK lines
```

---

## Reference URLs

- Repo: https://github.com/stephanieisapenguin/stephanie_swarm
- Gist (logs + mapping): https://gist.github.com/stephanieisapenguin/6944ac3b7c93b7d25cba18f27f33b73b
- Healthchecks dashboard: https://healthchecks.io/checks/cac90552-e328-4ed2-b9a3-e6afb470bec4/details/
- Audit routine (next: 2026-05-14 09:00 ET): https://claude.ai/code/routines/trig_01DNqfMXkFtWm9yNq6mBBvF3
