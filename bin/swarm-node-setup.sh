#!/bin/bash
# swarm-node-setup — one-command onboarding for a new laptop joining the
# compute pool.
#
# Usage (from a clone of this repo):
#   bin/swarm-node-setup.sh                 worker node: compute service only
#   bin/swarm-node-setup.sh --role hub      hub node: compute + dispatch + tunnel
#   bin/swarm-node-setup.sh --with-mlx      also: local MLX model server (qwen,
#                                           Apple Silicon, ~21 GB download) +
#                                           the web-search MCP server venv
#
# After it finishes, add this machine's URL (printed at the end) to
# COMPUTE_URLS in the hub's services/dispatch/.env and bounce dispatch.
set -eu

ROLE="worker"
WITH_MLX=0
while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="${2:-worker}"; shift 2 ;;
    --with-mlx) WITH_MLX=1; shift ;;
    *) echo "unknown flag: $1"; exit 1 ;;
  esac
done

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICES_DIR="$REPO_DIR/services"

echo "==> swarm node setup (role: $ROLE) in $REPO_DIR"

# 1. Dependencies -----------------------------------------------------------
if ! command -v brew >/dev/null; then
  echo "!! Homebrew missing — install from https://brew.sh first"; exit 1
fi
for pkg in node ollama uv jq; do
  command -v "$pkg" >/dev/null || { echo "==> brew install $pkg"; brew install "$pkg"; }
done
if [ "$ROLE" = "hub" ] && ! command -v cloudflared >/dev/null; then
  echo "==> brew install cloudflared"; brew install cloudflared
fi

# 2. Local model ------------------------------------------------------------
pgrep -x ollama >/dev/null || (echo "==> starting ollama"; brew services start ollama; sleep 3)
MODEL="${HERMES_MODEL:-hermes3:8b}"
ollama list 2>/dev/null | grep -q "^${MODEL%%:*}" || { echo "==> ollama pull $MODEL (~5 GB)"; ollama pull "$MODEL"; }

# 3. Node deps --------------------------------------------------------------
echo "==> npm install"
(cd "$SERVICES_DIR/compute" && npm install --silent)
[ "$ROLE" = "hub" ] && (cd "$SERVICES_DIR/dispatch" && npm install --silent)

# 4. Document converter -----------------------------------------------------
if [ ! -x "$SERVICES_DIR/converter/.venv/bin/python" ]; then
  echo "==> docling venv (python 3.13)"
  (cd "$SERVICES_DIR/converter" && uv venv --python 3.13 .venv >/dev/null \
    && uv pip install --quiet --python .venv/bin/python docling)
fi

# 4b. Local MLX model + web-search MCP (opt-in) -----------------------------
if [ "$WITH_MLX" = 1 ]; then
  echo "==> web-search MCP server venv"
  "$REPO_DIR/mcp-servers/web-search/setup.sh"
  echo "==> MLX model server (this downloads the model if missing)"
  "$SERVICES_DIR/mlx/setup.sh" --download
fi

# 5. Env template -----------------------------------------------------------
if [ ! -f "$SERVICES_DIR/.env" ]; then
  cat > "$SERVICES_DIR/.env" <<'EOF'
# Shared swarm services secrets — chmod 600, never commit.
#ANTHROPIC_API_KEY=
#OPENROUTER_API_KEY=
#TUNNEL_TOKEN=
#CLAUDE_BACKEND=cli

# harness (server-side MCP tool loop, compute /v1/agent/completions).
# Same random value on the hub and every compute node that should run tools.
# Unset ⇒ agent jobs are refused everywhere.  openssl rand -hex 24
#HARNESS_TOKEN=

# local MLX model (qwen backend) — see services/mlx/README.md
#MLX_MODEL=mlx-community/Qwen3.5-27B-6bit
#MLX_PORT=8321

# telegram-penguin bot (services/telegram-penguin) — token from @BotFather;
# chat ids are default-deny, rejected ids are logged so you can add them.
#TELEGRAM_BOT_TOKEN=
#TELEGRAM_ALLOWED_CHAT_IDS=

# node discovery (worker nodes): where the hub's dispatch lives + the shared
# key from the hub's services/.env. Compute self-registers and heartbeats;
# no COMPUTE_URLS editing needed.
#DISPATCH_URL=http://<hub-tailscale-ip>:8877
#SWARM_KEY=

# hub only — SWARM_KEY enables /nodes/register; static pool entries optional:
#COMPUTE_URLS=http://localhost:8878
EOF
  chmod 600 "$SERVICES_DIR/.env"
  echo "==> wrote $SERVICES_DIR/.env template (fill in keys as needed)"
fi

# 6. launchd services -------------------------------------------------------
echo "==> installing launchd services"
if [ "$ROLE" = "hub" ]; then
  "$REPO_DIR/bin/swarm-svc-plists-install.sh"
else
  "$REPO_DIR/bin/swarm-svc-plists-install.sh" --only compute
fi
[ "$WITH_MLX" = 1 ] && "$REPO_DIR/bin/swarm-svc-plists-install.sh" --only mlx

# 7. recovery watchdog — re-probes every 5 min and bounces anything unhealthy
echo "==> installing recovery watchdog"
"$REPO_DIR/bin/swarm-svc-recover.sh" --install-watchdog

# 8. Verify + print pool line ----------------------------------------------
sleep 3
"$REPO_DIR/bin/swarm-check.sh" || true

HOSTNAME_TS="$(command -v tailscale >/dev/null && tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//' || true)"
ADDR="${HOSTNAME_TS:-$(ipconfig getifaddr en0 2>/dev/null || hostname)}"
echo ""
if grep -q "^DISPATCH_URL=" "$SERVICES_DIR/.env" && grep -q "^SWARM_KEY=" "$SERVICES_DIR/.env"; then
  echo "==> node ready — it will self-register with the hub and join the pool"
  echo "    (watch: grep register $SERVICES_DIR/compute.log)"
else
  echo "==> node ready. To join the hub's pool automatically, set in $SERVICES_DIR/.env:"
  echo "      DISPATCH_URL=http://<hub-tailscale-ip>:8877"
  echo "      SWARM_KEY=<value from the hub's services/.env>"
  echo "    then: launchctl kickstart -k gui/\$(id -u)/com.\$USER.swarm-svc.compute"
  echo "    (manual alternative: add http://${ADDR}:8878 to COMPUTE_URLS on the hub)"
fi
