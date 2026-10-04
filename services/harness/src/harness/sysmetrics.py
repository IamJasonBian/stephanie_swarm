"""Laptop / capacity sample: CPU, memory, swap, load, battery, and what the
local model server has resident. Taken by each dispatcher every
HARNESS_SAMPLE_S and stored in the `samples` table (see store.metrics)."""
import json
import os
import urllib.request
from typing import Any

import psutil

OLLAMA = os.environ.get("OLLAMA_HOST_URL", "http://localhost:11434").rstrip("/")


def _ollama_ps() -> list[dict[str, Any]] | None:
    try:
        with urllib.request.urlopen(f"{OLLAMA}/api/ps", timeout=1) as res:
            models = json.loads(res.read()).get("models", [])
    except Exception:
        return None  # server down / not Ollama
    return [{
        "model": m.get("name"),
        "size_gb": round(m.get("size", 0) / 1e9, 2),
        "vram_gb": round(m.get("size_vram", 0) / 1e9, 2),
        "context": m.get("context_length"),
    } for m in models]


def sample(running_jobs: int, queued_jobs: int) -> dict[str, Any]:
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    load1, load5, _ = os.getloadavg()
    battery = psutil.sensors_battery()
    models = _ollama_ps()
    return {
        "cpu_pct": psutil.cpu_percent(interval=None),  # since previous call
        "cpu_count": psutil.cpu_count(),
        "load_1m": round(load1, 2),
        "load_5m": round(load5, 2),
        "mem_used_gb": round((vm.total - vm.available) / 1e9, 2),
        "mem_total_gb": round(vm.total / 1e9, 2),
        "mem_pct": vm.percent,
        "swap_used_gb": round(sw.used / 1e9, 2),
        "battery_pct": round(battery.percent, 1) if battery else None,
        "on_ac_power": battery.power_plugged if battery else None,
        "models_loaded": models,
        "model_vram_gb": round(sum(m["vram_gb"] for m in models), 2) if models else 0,
        "running_jobs": running_jobs,
        "queued_jobs": queued_jobs,
    }


def one_line(s: dict[str, Any]) -> str:
    batt = f" batt {s['battery_pct']:.0f}%{'⚡' if s['on_ac_power'] else ''}" if s.get("battery_pct") is not None else ""
    models = ",".join(m["model"] for m in (s.get("models_loaded") or [])) or "none"
    return (f"cpu {s['cpu_pct']:.0f}% load {s['load_1m']} | mem {s['mem_used_gb']}/{s['mem_total_gb']}GB "
            f"({s['mem_pct']:.0f}%) swap {s['swap_used_gb']}GB |{batt} | models {s['model_vram_gb']}GB [{models}] "
            f"| jobs running {s['running_jobs']} queued {s['queued_jobs']}")
