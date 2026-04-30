#!/usr/bin/env python3
"""launchd entry point for one stephanie bot.
Argv: <bot-working-dir>. Loads its .env (CLAUDE_CONFIG_DIR etc) into os.environ,
then exec's the bot binary. Robust against unquoted spaces / commas in .env values.
KeepAlive in the plist handles crash-restart.
"""
import os
import pathlib
import sys


def main() -> None:
    if len(sys.argv) < 2:
        sys.stderr.write(f"usage: {sys.argv[0]} <working-dir>\n")
        sys.exit(2)

    workdir = pathlib.Path(sys.argv[1])
    if not workdir.is_dir():
        sys.stderr.write(f"not a directory: {workdir}\n")
        sys.exit(2)
    os.chdir(workdir)

    env_file = workdir / ".env"
    if env_file.exists():
        for raw in env_file.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            # strip a single layer of matched surrounding quotes
            if (
                len(value) >= 2
                and value[0] == value[-1]
                and value[0] in ("'", '"')
            ):
                value = value[1:-1]
            if key:
                os.environ[key] = value

    binary = "/Users/jasonzb/.local/bin/claude-telegram-bot"
    os.execvp(binary, [binary])


if __name__ == "__main__":
    main()
