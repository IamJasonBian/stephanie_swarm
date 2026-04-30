distributed_stephanie_bots

```bash
for d in /Users/jasonzb/claude-code-telegram*/; do
  d="${d%/}"; [ -f "$d/.env" ] || continue
  lsof -t "$d/data/bot.db" >/dev/null 2>&1 || (cd "$d" && nohup /Users/jasonzb/.local/bin/claude-telegram-bot >> bot.log 2>&1 < /dev/null &)
done
launchctl load -w ~/Library/LaunchAgents/com.jasonzb.stephanie-uptime.plist 2>/dev/null
launchctl load -w ~/Library/LaunchAgents/com.jasonzb.stephanie-uptime-gist.plist 2>/dev/null
```
