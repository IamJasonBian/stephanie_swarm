"""Render mini-swe-agent trajectories + a scoreboard into an animated GIF.

usage: python make_gif.py OUT.gif RESULTS.json RUN_DIR[=label] [RUN_DIR[=label] ...]
RESULTS.json: [{"model", "task", "status", "resolved", "calls", "patch_chars"}]
"""
import json
import sys
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H, PAD, LH = 1100, 640, 24, 19
FONT = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 14)
BOLD = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 17, index=1)
BG, FG, DIM, CMD, OK, BAD, ACC = "#0d1117", "#c9d1d9", "#8b949e", "#79c0ff", "#3fb950", "#f85149", "#d2a8ff"
COLS = (W - 2 * PAD) // 8 - 1
ROWS = (H - 90) // LH


def frame(title: str, sub: str, lines: list[tuple[str, str]]) -> Image.Image:
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.text((PAD, 16), title, font=BOLD, fill=ACC)
    d.text((PAD, 42), sub, font=FONT, fill=DIM)
    d.line((PAD, 66, W - PAD, 66), fill="#30363d")
    y = 76
    for color, text in lines[-ROWS:]:
        d.text((PAD, y), text, font=FONT, fill=color or FG)
        y += LH
    return im


def wrap(color: str, text: str, limit: int) -> list[tuple[str, str]]:
    out = []
    for raw in text.splitlines()[:limit]:
        out += [(color, s) for s in (textwrap.wrap(raw, COLS) or [""])]
    return out[: limit * 2]


def steps(traj: dict):
    msgs = traj["messages"]
    for i, m in enumerate(msgs):
        for tc in m.get("tool_calls") or []:
            try:
                cmd = json.loads(tc["function"]["arguments"]).get("command", "")
            except (ValueError, KeyError):
                cmd = str(tc)
            nxt = msgs[i + 1] if i + 1 < len(msgs) else {}
            out = str(nxt.get("content") or "")
            out = out.replace("<returncode>", "rc=").replace("</returncode>", "").replace("<output>", "").replace("</output>", "")
            yield cmd, out.strip()


def run_frames(run: Path, label: str, results: dict) -> list[tuple[Image.Image, int]]:
    frames = []
    for tf in sorted(run.glob("*/*.traj.json")):
        task = tf.parent.name
        traj = json.loads(tf.read_text())
        r = results.get((label, task), {})
        verdict = "RESOLVED" if r.get("resolved") else r.get("status", "?")
        title = f"SWE-bench Lite · {task}"
        buf: list[tuple[str, str]] = []
        all_steps = list(steps(traj))
        for n, (cmd, out) in enumerate(all_steps, 1):
            buf += [(DIM, f"── step {n}/{len(all_steps)}")] + wrap(CMD, "$ " + cmd, 6) + wrap(FG, out, 8)
            if n <= 6 or n % 4 == 0 or n == len(all_steps):
                frames.append((frame(title, f"{label} · step {n}", buf), 900))
        buf += [("", ""), (OK if r.get("resolved") else BAD, f"=> {verdict}  ({r.get('calls', '?')} model calls, patch {r.get('patch_chars', 0)} chars)")]
        frames.append((frame(title, f"{label} · done", buf), 2500))
    return frames


def scoreboard(rows: list[dict]) -> Image.Image:
    lines = [(DIM, f"{'model':<28}{'task':<26}{'result':<18}{'calls':>6}{'patch':>8}"), (DIM, "─" * 86)]
    for r in rows:
        res = "RESOLVED" if r["resolved"] else r["status"]
        lines.append((OK if r["resolved"] else BAD, f"{r['model']:<28}{r['task']:<26}{res:<18}{r['calls']:>6}{r['patch_chars']:>8}"))
    by = {}
    for r in rows:
        by.setdefault(r["model"], []).append(r["resolved"])
    lines += [("", "")] + [(ACC, f"{m}: {sum(v)}/{len(v)} resolved") for m, v in by.items()]
    return frame("SWE-bench Lite · local models on M4 Pro (48 GB)", "mini-swe-agent · swebench eval (docker, linux/amd64 via QEMU)", lines)


if __name__ == "__main__":
    out, res_path, *runs = sys.argv[1:]
    rows = json.loads(Path(res_path).read_text())
    results = {(r["model"], r["task"]): r for r in rows}
    board = scoreboard(rows)
    frames = [(board, 3000)]
    for spec in runs:
        path, _, label = spec.partition("=")
        frames += run_frames(Path(path), label or Path(path).name, results)
    frames.append((board, 5000))
    ims, durs = zip(*frames)
    ims = [im.convert("P", palette=Image.ADAPTIVE, colors=64) for im in ims]
    ims[0].save(out, save_all=True, append_images=ims[1:], duration=list(durs), loop=0, optimize=True)
    print(f"{out}: {len(ims)} frames")
