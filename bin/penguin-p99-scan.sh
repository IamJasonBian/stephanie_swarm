#!/usr/bin/env python3
"""Scan each bot's bot.log for `Claude command completed` events whose
duration_ms exceeds THRESHOLD_MS and append them to a single append-only
penguin log. Dedup via per-bot state files tracking the latest timestamp
seen, so re-runs are idempotent and only emit newly-arrived events.

Triggered by ~/Library/LaunchAgents/com.jasonzb.penguin-p99.plist every 5min.
Manual run: just execute this script.
"""
from __future__ import annotations

import glob
import json
from pathlib import Path

THRESHOLD_MS = 600_000  # 10 minutes
HOME = Path.home()
LOG_OUT = HOME / ".claude-stephanie2" / "PENGUIN_P99_EVENTS.log"
STATE_DIR = HOME / "Library" / "Application Support" / "penguin-p99"
WORKDIR_GLOB = str(HOME / "claude-code-telegram*")

STATE_DIR.mkdir(parents=True, exist_ok=True)
LOG_OUT.parent.mkdir(parents=True, exist_ok=True)


def emit(entry: dict, bot: str) -> str:
    dur_s = entry.get("duration_ms", 0) / 1000.0
    turns = entry.get("num_turns", "?")
    cost = entry.get("cost", 0.0)
    session = entry.get("session_id", "")
    err = entry.get("is_error", False)
    flag = "ERROR" if err else "ok"
    return (
        f"{entry['timestamp']}  bot={bot:<35} "
        f"duration={dur_s:>6.0f}s  turns={str(turns):>3}  "
        f"cost=${cost:>7.4f}  {flag}  session={session}\n"
    )


def main() -> None:
    new_events_total = 0
    for d in sorted(glob.glob(WORKDIR_GLOB)):
        d_path = Path(d)
        if not d_path.is_dir():
            continue
        bot = d_path.name
        log_path = d_path / "bot.log"
        if not log_path.is_file():
            continue
        state_path = STATE_DIR / f"{bot}.last"
        last_ts = (
            state_path.read_text().strip() if state_path.exists() else "1970-01-01T00:00:00Z"
        )

        new_last = last_ts
        emitted_lines: list[str] = []
        try:
            with log_path.open("r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if '"Claude command completed"' not in line:
                        continue
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    ts = ev.get("timestamp", "")
                    if not ts or ts <= last_ts:
                        continue
                    if ts > new_last:
                        new_last = ts
                    if ev.get("duration_ms", 0) < THRESHOLD_MS:
                        continue
                    emitted_lines.append(emit(ev, bot))
        except OSError:
            continue

        if emitted_lines:
            with LOG_OUT.open("a", encoding="utf-8") as out:
                out.writelines(emitted_lines)
            new_events_total += len(emitted_lines)

        if new_last != last_ts:
            state_path.write_text(new_last)

    if new_events_total:
        print(f"penguin-p99-scan: appended {new_events_total} event(s) to {LOG_OUT}")


if __name__ == "__main__":
    main()
