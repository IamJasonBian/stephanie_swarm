"""stephanie-network MCP server.

Exposes the bot-network coordination scripts (roundtable, dispatch, background
tasks, recipient management) as MCP tools so any bot's Claude session can
invoke them with typed parameters instead of via shell skills.

Tools shell out to the existing scripts in ~/bin and shared state files.
The server is spawned by the Claude SDK with the calling bot's workdir as CWD,
which is what dispatch.sh and bg-task.sh need to identify "self".
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("stephanie-network")

BIN = Path("/Users/jasonzb/bin")
RECIPIENTS_FILE = Path.home() / ".config/stephanie-weekly-checkin/recipients.txt"


def _run(cmd: list[str], timeout: int = 600) -> str:
    """Run a shell command, return stdout+stderr combined. Inherits CWD from the MCP server process (= the calling bot's workdir)."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return f"timeout after {timeout}s"
    out = (result.stdout or "").strip()
    err = (result.stderr or "").strip()
    if err and not out:
        return f"(stderr) {err}"
    if err:
        return f"{out}\n(stderr) {err}"
    return out or "(no output)"


@mcp.tool()
def roundtable(topic: str) -> str:
    """Run a multi-bot roundtable on a topic.

    Walks through all six stephanie-* bots in workdir-sorted order. Each bot
    reads the shared chat log + its own memory, contributes a 1-3 sentence
    response, appends to the log, and posts via its own Telegram token to all
    recipients. Sequential — later bots see earlier bots' contributions.

    Cost: ~$0.30-1.50. Time: ~30-60s.

    Args:
        topic: The topic for the roundtable.
    """
    if not topic.strip():
        return "topic is required"
    return _run([str(BIN / "stephanie-roundtable.sh"), topic])


@mcp.tool()
def dispatch(prompt: str) -> str:
    """Fan out a prompt to every OTHER bot in the network (excludes self).

    Each other bot independently runs Claude headlessly with the prompt and
    posts its own response via its own Telegram token. "Self" is determined
    from the calling bot's workdir (this MCP server's CWD).

    Cost: ~$0.25-1.00. Time: ~30-60s.

    Args:
        prompt: The prompt to fan out.
    """
    if not prompt.strip():
        return "prompt is required"
    return _run([str(BIN / "stephanie-dispatch.sh"), prompt])


@mcp.tool()
def background_task(prompt: str) -> str:
    """Run a Claude prompt in the background, outside the bot's 120s timeout.

    Returns immediately with a job ID. The actual result is posted as a
    separate Telegram message from the calling bot's identity when the task
    finishes. Useful for prompts that would otherwise time out.

    Args:
        prompt: The prompt to run in the background.
    """
    if not prompt.strip():
        return "prompt is required"
    return _run([str(BIN / "stephanie-bg-task.sh"), prompt], timeout=15)


@mcp.tool()
def list_recipients() -> str:
    """List the Telegram chat IDs that receive bot-network messages
    (weekly check-ins, dispatch results, roundtable turns, background-task results).
    """
    if not RECIPIENTS_FILE.exists():
        return "(no recipients file yet)"
    lines = []
    for raw in RECIPIENTS_FILE.read_text().splitlines():
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        lines.append(s)
    if not lines:
        return "(no recipients)"
    return "\n".join(lines)


@mcp.tool()
def add_recipient(chat_id: str) -> str:
    """Add a Telegram chat ID to the bot-network recipients list.

    Args:
        chat_id: Numeric Telegram chat ID (positive for user/private chats,
                 negative for groups/channels).
    """
    chat_id = chat_id.strip()
    if not chat_id.lstrip("-").isdigit():
        return f"invalid chat_id: {chat_id!r} (must be numeric)"
    RECIPIENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    existing = []
    if RECIPIENTS_FILE.exists():
        existing = RECIPIENTS_FILE.read_text().splitlines()
        for raw in existing:
            if raw.strip() == chat_id:
                return f"{chat_id} already in recipients"
    with RECIPIENTS_FILE.open("a") as f:
        f.write(chat_id + "\n")
    return f"added {chat_id}"


@mcp.tool()
def remove_recipient(chat_id: str) -> str:
    """Remove a Telegram chat ID from the bot-network recipients list.

    Args:
        chat_id: Numeric Telegram chat ID.
    """
    chat_id = chat_id.strip()
    if not RECIPIENTS_FILE.exists():
        return "(no recipients file)"
    kept = []
    removed = False
    for raw in RECIPIENTS_FILE.read_text().splitlines():
        if raw.strip() == chat_id:
            removed = True
            continue
        kept.append(raw)
    if not removed:
        return f"{chat_id} not in recipients"
    RECIPIENTS_FILE.write_text("\n".join(kept) + "\n")
    return f"removed {chat_id}"


if __name__ == "__main__":
    mcp.run()
