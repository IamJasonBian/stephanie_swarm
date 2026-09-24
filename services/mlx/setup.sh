#!/bin/bash
# services/mlx — local MLX model server (Apple Silicon), OpenAI-compatible.
# Builds the venv and optionally pre-downloads the model into the shared
# Hugging Face cache (~/.cache/huggingface/hub — the same cache `hf download`
# and the `models` manager use, so nothing is duplicated).
#
# Usage:
#   services/mlx/setup.sh                 venv only (server downloads on first start)
#   services/mlx/setup.sh --download      also fetch MLX_MODEL now (~21 GB for Qwen3.5-27B-6bit)
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
MODEL="${MLX_MODEL:-mlx-community/Qwen3.5-27B-6bit}"

[ "$(uname -m)" = "arm64" ] || { echo "!! MLX needs Apple Silicon (arm64); this is $(uname -m)"; exit 1; }
command -v uv >/dev/null || { echo "!! uv missing — brew install uv"; exit 1; }

if [ ! -x "$HERE/.venv/bin/python" ]; then
  echo "==> creating venv"
  uv venv "$HERE/.venv" >/dev/null
fi
echo "==> installing mlx-vlm + huggingface_hub"
uv pip install --quiet --python "$HERE/.venv/bin/python" -r "$HERE/requirements.txt"
"$HERE/.venv/bin/python" -c "import mlx_vlm, huggingface_hub; print('mlx-vlm', mlx_vlm.__version__)"

if [ "${1:-}" = "--download" ]; then
  echo "==> downloading $MODEL (resumable; Ctrl-C and rerun to continue)"
  HF_HUB_ENABLE_HF_TRANSFER=0 "$HERE/.venv/bin/hf" download "$MODEL" --max-workers 2
fi

echo "==> mlx ready. Start by hand:"
echo "    bin/swarm-svc-launcher.sh services mlx"
echo "    or install under launchd: bin/swarm-svc-plists-install.sh --only mlx"
