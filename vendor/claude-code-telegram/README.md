# vendor/claude-code-telegram

Snapshots of files we patched inside the installed `claude-code-telegram`
venv. These are **not** wired into the running bots — the live copy lives at:

    ~/.local/share/uv/tools/claude-code-telegram/lib/python3.13/site-packages/src/bot/orchestrator.py

This directory exists so the patches survive a reinstall/upgrade. If the
venv copy gets blown away, diff it against the file here and re-apply.

## Files

- `src/bot/orchestrator.py` — instant ACK, regex pre-filter, preflight
  warnings, time/tool-call limits watchdog. ~80–100 lines of local edits
  on top of upstream.

## Re-applying after upgrade

    diff -u vendor/claude-code-telegram/src/bot/orchestrator.py \
            ~/.local/share/uv/tools/claude-code-telegram/lib/python3.13/site-packages/src/bot/orchestrator.py

…then port the deltas back into the venv copy and restart the bots.
