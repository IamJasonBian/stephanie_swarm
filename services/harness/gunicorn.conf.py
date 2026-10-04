# API only — the dispatcher runs as its own process (see dev.sh / README).
# gthread so long-polling GET /v1/jobs/<id>?wait= doesn't pin a whole worker.
from harness.config import load

_cfg = load()
bind = f"{_cfg.host}:{_cfg.port}"
worker_class = "gthread"
workers = 2
threads = 16
timeout = int(_cfg.max_wait_s) + 15
