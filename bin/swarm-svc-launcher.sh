#!/bin/bash
# Launch one swarm service under launchd (or by hand).
# Usage: swarm-svc-launcher.sh <services-dir> <compute|dispatch|tunnel|frontend>
#
# Env files are sourced in order (later wins), so machine-local config
# stays out of git:
#   <services-dir>/.env             shared (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, TUNNEL_TOKEN, ...)
#   <services-dir>/<service>/.env   per-service overrides (PORT, HERMES_MODEL, ...)
set -eu

SERVICES_DIR="$1"
WHAT="$2"

for f in "$SERVICES_DIR/.env" "$SERVICES_DIR/$WHAT/.env"; do
  if [ -f "$f" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$f"
    set +a
  fi
done

case "$WHAT" in
  compute|dispatch)
    cd "$SERVICES_DIR/$WHAT"
    exec node src/index.ts
    ;;
  frontend)
    # Coach in a Cave UI (:8879) — proxies to compute.
    cd "$SERVICES_DIR/frontend"
    exec python3 server.py
    ;;
  tunnel)
    # Named tunnel (stable hostname, same pattern as apollo/beta/alpha's
    # docker cloudflared) when TUNNEL_TOKEN is set; otherwise a quick tunnel —
    # the ephemeral trycloudflare.com URL is printed into the service log.
    if [ -n "${TUNNEL_TOKEN:-}" ]; then
      exec cloudflared tunnel run --token "$TUNNEL_TOKEN"
    else
      exec cloudflared tunnel --url "http://localhost:${DISPATCH_PORT:-8877}"
    fi
    ;;
  *)
    echo "unknown service: $WHAT (expected compute|dispatch|tunnel|frontend)" >&2
    exit 1
    ;;
esac
