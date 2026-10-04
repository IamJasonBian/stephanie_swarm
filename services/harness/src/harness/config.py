import os
from dataclasses import dataclass, field


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default).strip() or default


@dataclass(frozen=True)
class Config:
    db_path: str = field(default_factory=lambda: _env("HARNESS_DB", "data/harness.db"))
    host: str = field(default_factory=lambda: _env("HARNESS_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(_env("HARNESS_PORT", "8790")))
    # Empty = auth off (local dev). Otherwise callers send `Authorization: Bearer <key>`.
    api_key: str = field(default_factory=lambda: os.environ.get("HARNESS_API_KEY", "").strip())

    # Dispatcher: how many jobs run at once on this machine (one process each).
    max_workers: int = field(default_factory=lambda: int(_env("HARNESS_MAX_WORKERS", "4")))
    poll_interval_s: float = field(default_factory=lambda: float(_env("HARNESS_POLL_S", "0.25")))
    # A running job whose dispatcher hasn't heartbeated for lease_s is presumed
    # orphaned (dispatcher killed / machine gone) and gets requeued or failed.
    heartbeat_s: float = field(default_factory=lambda: float(_env("HARNESS_HEARTBEAT_S", "5")))
    lease_s: float = field(default_factory=lambda: float(_env("HARNESS_LEASE_S", "30")))
    # On SIGTERM: stop claiming, let running jobs finish for this long, then
    # kill and release them back to the queue.
    shutdown_grace_s: float = field(default_factory=lambda: float(_env("HARNESS_SHUTDOWN_GRACE_S", "30")))
    retry_backoff_s: float = field(default_factory=lambda: float(_env("HARNESS_RETRY_BACKOFF_S", "5")))

    default_timeout_s: float = field(default_factory=lambda: float(_env("HARNESS_DEFAULT_TIMEOUT_S", "600")))
    default_max_attempts: int = field(default_factory=lambda: int(_env("HARNESS_DEFAULT_MAX_ATTEMPTS", "3")))
    max_wait_s: float = 30.0  # cap for GET /v1/jobs/<id>?wait=


def load() -> Config:
    return Config()
