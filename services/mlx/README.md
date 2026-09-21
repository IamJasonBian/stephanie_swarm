# services/mlx — local MLX model server

Runs `mlx_vlm.server` on `127.0.0.1:8321` serving
`mlx-community/Qwen3.5-27B-6bit` (override with `MLX_MODEL`, `MLX_PORT`).
It is the `qwen` backend behind compute's `/v1/chat/completions` and the
default model for the `web-readonly` harness profile.

```bash
services/mlx/setup.sh --download        # venv + model (~21 GB, resumable)
bin/swarm-svc-plists-install.sh --only mlx
curl -s localhost:8321/v1/models         # lists the loaded model when ready
```

Loopback only by design: other swarm machines reach this model through this
node's compute service (`:8878`), never the raw model port. One request at a
time (`--max-num-seqs 1`) — a 27B model on a 48 GiB Mac; dispatch's
`QWEN_CONCURRENCY=1` mirrors that.

Cold start (weights → unified memory) takes ~30–60 s; compute reports
`backends.qwen.ready=false` until `/v1/models` lists the model, and
`swarm-svc-recover.sh` gives it that grace before bouncing.
