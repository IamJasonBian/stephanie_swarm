#!/bin/bash
# Show state of remote tasks started with remote-task.sh.
# Usage: remote-task-status.sh [<job>]   (no job = list all)
set -u
ROOT="${WORK_ROOT:-$HOME/work}/logs/remote-tasks"
jobs=("${1:-}")
[ -z "${1:-}" ] && jobs=($(ls "$ROOT" 2>/dev/null))
for j in "${jobs[@]}"; do
  [ -d "$ROOT/$j" ] || { echo "$j: no such task"; continue; }
  echo "== $j: $(cat "$ROOT/$j/status" 2>/dev/null || echo 'no status')"
  grep "^===" "$ROOT/$j/$j.log" 2>/dev/null | tail -4
done
