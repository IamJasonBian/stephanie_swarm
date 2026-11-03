#!/bin/bash
# Run one supervised headless Claude task (e.g. "cut a diff and open a PR") detached on
# this node, so it keeps going after the laptop that started it sleeps.
# Usage: remote-task.sh <job> <owner/repo> <brief.md> ['<done-check shell command>']
#
# - Clones <owner/repo> fresh into $WORK_ROOT/<job> (default ~/work), runs SETUP, then `claude -p "<brief>"`.
# - If a done-check is given, resumes with `claude -p --continue` until it exits 0,
#   DEADLINE_SECS (default 7200) passes, or MAX_PASSES (default 10). No check = one pass.
# - Tools are allow-listed: read/edit, git, gh pr, project test runner. No merge/deploy.
# - Logs (stream-json) + brief + status go to $WORK_ROOT/logs/remote-tasks/<job>/.
# - When finished, deletes the clone if every local branch is pushed and the tree is
#   clean (KEEP_CLONE=1 to keep it).
# Launch detached:  nohup remote-task.sh ... >/dev/null 2>&1 </dev/null & disown
# Check:            remote-task-status.sh <job>
set -u
export PATH=/opt/homebrew/bin:$HOME/.local/bin:$PATH

JOB="$1"; REPO="$2"; BRIEF_SRC="$3"; DONE_CHECK="${4:-}"
WORK_ROOT="${WORK_ROOT:-$HOME/work}"
DEADLINE_SECS="${DEADLINE_SECS:-7200}"
MAX_PASSES="${MAX_PASSES:-10}"
SETUP="${SETUP:-[ -f requirements.txt ] && uv venv -q .venv && uv pip install -q --python .venv/bin/python -r requirements.txt pytest}"
ALLOWED_TOOLS="${ALLOWED_TOOLS:-Read,Edit,Write,Grep,Glob,Bash(git:*),Bash(gh pr create:*),Bash(gh pr view:*),Bash(gh pr list:*),Bash(gh pr edit:*),Bash(.venv/bin/python:*),Bash(npm test:*),Bash(ls:*),Bash(cat:*),Bash(grep:*),Bash(sed -n:*)}"

DIR="$WORK_ROOT/logs/remote-tasks/$JOB"
LOG="$DIR/$JOB.log"; STATUS="$DIR/status"; CLONE="$WORK_ROOT/$JOB"
mkdir -p "$DIR"
cp "$BRIEF_SRC" "$DIR/brief.md"
DEADLINE=$(( $(date +%s) + DEADLINE_SECS ))
FLAGS=(--permission-mode acceptEdits --allowedTools "$ALLOWED_TOOLS"
       --max-turns 150 --output-format stream-json --verbose)

done_ok() { [ -n "$DONE_CHECK" ] && bash -c "$DONE_CHECK" >/dev/null 2>&1; }
clone_clean() {
  [ -z "$(git -C "$CLONE" status --porcelain --untracked-files=no)" ] || return 1
  for b in $(git -C "$CLONE" for-each-ref --format='%(refname:short)' refs/heads); do
    up=$(git -C "$CLONE" rev-parse --abbrev-ref "$b@{upstream}" 2>/dev/null) || return 1
    [ "$(git -C "$CLONE" rev-list --count "$up..$b")" = 0 ] || return 1
  done
}

{
echo "running pid=$$ started=$(date)" > "$STATUS"
echo "=== start $(date) job=$JOB repo=$REPO deadline=$(date -r "$DEADLINE")"
rm -rf "$CLONE" && gh repo clone "$REPO" "$CLONE" -- -q || { echo "=== clone failed"; echo "failed clone $(date)" > "$STATUS"; exit 1; }
cd "$CLONE" && git fetch -q origin
bash -c "$SETUP" || echo "=== setup warning"
echo "=== pass 1 $(date)"
claude -p "$(cat "$DIR/brief.md")" "${FLAGS[@]}"
n=1
if [ -n "$DONE_CHECK" ]; then
  while ! done_ok && [ "$(date +%s)" -lt "$DEADLINE" ] && [ "$n" -lt "$MAX_PASSES" ]; do
    n=$((n+1)); sleep 30
    echo "=== pass $n (continue) $(date)"
    claude -p --continue "Keep working on the task in the brief until it is complete. Reuse existing branches/PRs instead of opening duplicates. Print the PR URLs when done." "${FLAGS[@]}"
  done
fi
result="done=$(done_ok && echo yes || { [ -n "$DONE_CHECK" ] && echo no || echo n/a; }) passes=$n"
cd "$WORK_ROOT"
if [ "${KEEP_CLONE:-0}" != 1 ] && clone_clean; then rm -rf "$CLONE"; result="$result clone=removed"; else result="$result clone=kept"; fi
echo "=== finished $(date) $result"
echo "finished $(date) $result" > "$STATUS"
} >> "$LOG" 2>&1
