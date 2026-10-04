#!/usr/bin/env bash
# Local loop: API (gunicorn) + one dispatcher (+ Telegram bridge when
# TELEGRAM_BOT_TOKEN is set in .env). Ctrl-C stops all; the dispatcher
# drains running jobs for HARNESS_SHUTDOWN_GRACE_S first.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
uv run harness-dispatcher &
PIDS=$!
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  uv run harness-telegram &
  PIDS="$PIDS $!"
fi
trap 'kill -TERM $PIDS 2>/dev/null; wait $PIDS' EXIT
uv run gunicorn -c gunicorn.conf.py harness.api:app
