#!/bin/bash
# Build the web-search MCP server's venv. Idempotent.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v uv >/dev/null || { echo "uv missing — brew install uv"; exit 1; }
[ -x "$HERE/.venv/bin/python" ] || uv venv "$HERE/.venv" >/dev/null
uv pip install --quiet --python "$HERE/.venv/bin/python" -r "$HERE/requirements.txt"
"$HERE/.venv/bin/python" -c "import mcp, ddgs; print('web-search MCP deps ok')"
