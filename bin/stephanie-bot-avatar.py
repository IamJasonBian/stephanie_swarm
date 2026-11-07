#!/usr/bin/env python3
"""Rotate each stephanie bot's Telegram profile photo on a schedule.

Runs as a launchd job (see LaunchAgents/com.jasonzb.stephanie-bot-avatar.plist).
It is safe to run often: each bot changes photo at most once per rotation
period (AVATAR_INTERVAL_DAYS, 7 by default), so a daily run catches up after
the Mac was asleep or off.

Opt-in is per bot. Put these in the bot's working dir .env
(/Users/<you>/claude-code-telegram-<bot>/.env):

    AVATAR_ROTATE=1                     # turn rotation on for this bot
    AVATAR_SOURCE=local                 # local | telegram | both (default: local,
                                        #   falling back to telegram if no images)
    AVATAR_DIR=/path/to/images          # default: <workdir>/avatars
    AVATAR_STICKER_SET=SomeStickerSet   # Telegram sticker set short name
                                        #   (t.me/addstickers/<name>)
    AVATAR_INTERVAL_DAYS=7              # rotation period
    AVATAR_KEEP_HISTORY=0               # 1 keeps old photos in the bot's history

A bot token cannot change a bot's own photo. Instead the owner's *user*
account (the one that created the bot in BotFather) does it with
photos.uploadProfilePhoto(bot=...). Shared credentials live in
~/.config/stephanie-avatar.conf (or the environment):

    TG_API_ID=1234567                   # from https://my.telegram.org
    TG_API_HASH=0123456789abcdef...
    TG_SESSION=~/.config/stephanie-avatar/owner   # Telethon session path

One-time login (interactive, creates the session file):

    stephanie-bot-avatar.py --login

Other flags: --dry-run, --force, --bot <name> (repeatable), --workdir-glob.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import io
import json
import os
import pathlib
import sys
import time
from datetime import datetime, timezone

DEFAULT_WORKDIR_GLOB = os.path.expanduser("~/claude-code-telegram*")
DEFAULT_CONF = os.path.expanduser("~/.config/stephanie-avatar.conf")
DEFAULT_SESSION = os.path.expanduser("~/.config/stephanie-avatar/owner")
STATE_FILE = ".avatar_state.json"
CACHE_DIR = ".avatar_cache"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
TRUTHY = {"1", "true", "yes", "on"}


# --------------------------------------------------------------------------
# config helpers (stdlib only, unit-testable without telethon)
# --------------------------------------------------------------------------

def parse_env_file(path: pathlib.Path) -> dict[str, str]:
    """Same .env rules as stephanie-bot-launcher.sh."""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            out[key] = value
    return out


def truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in TRUTHY


def period_index(now: float, interval_days: int) -> int:
    """Which rotation period `now` falls in, counted from the Unix epoch."""
    return int(now // (max(1, interval_days) * 86400))


def pick(items: list, period: int, bot_name: str):
    """Deterministic pick: walks the list one step per period. The bot name
    offsets the start so bots sharing a folder don't all wear the same photo."""
    if not items:
        return None
    offset = int(hashlib.sha256(bot_name.encode()).hexdigest(), 16) % len(items)
    return items[(period + offset) % len(items)]


def list_local_images(directory: pathlib.Path) -> list[pathlib.Path]:
    if not directory.is_dir():
        return []
    return sorted(
        p for p in directory.iterdir()
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS and not p.name.startswith(".")
    )


class BotConfig:
    def __init__(self, workdir: pathlib.Path, env: dict[str, str]):
        self.workdir = workdir
        self.name = workdir.name
        self.env = env
        self.username = env.get("TELEGRAM_BOT_USERNAME", "").lstrip("@")
        self.enabled = truthy(env.get("AVATAR_ROTATE"))
        self.source = (env.get("AVATAR_SOURCE") or "local").strip().lower()
        self.dir = pathlib.Path(os.path.expanduser(env.get("AVATAR_DIR") or str(workdir / "avatars")))
        self.sticker_set = (env.get("AVATAR_STICKER_SET") or "").strip()
        try:
            self.interval_days = int(env.get("AVATAR_INTERVAL_DAYS") or 7)
        except ValueError:
            self.interval_days = 7
        self.keep_history = truthy(env.get("AVATAR_KEEP_HISTORY"))

    @property
    def state_path(self) -> pathlib.Path:
        return self.workdir / STATE_FILE

    def load_state(self) -> dict:
        try:
            return json.loads(self.state_path.read_text())
        except Exception:
            return {}

    def save_state(self, state: dict) -> None:
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2) + "\n")
        tmp.replace(self.state_path)


def discover_bots(workdir_glob: str, only: list[str] | None) -> list[BotConfig]:
    bots = []
    for d in sorted(glob.glob(workdir_glob)):
        p = pathlib.Path(d)
        if not (p.is_dir() and (p / ".env").is_file()):
            continue
        cfg = BotConfig(p, parse_env_file(p / ".env"))
        if only and not ({cfg.name, cfg.username, "@" + cfg.username} & set(only)):
            continue
        bots.append(cfg)
    return bots


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")
    print(f"{ts} {msg}", flush=True)


# --------------------------------------------------------------------------
# Telegram side
# --------------------------------------------------------------------------

def make_client(conf: dict[str, str]):
    from telethon.sync import TelegramClient

    try:
        api_id = int(conf["TG_API_ID"])
        api_hash = conf["TG_API_HASH"]
    except (KeyError, ValueError):
        sys.exit("TG_API_ID / TG_API_HASH missing: set them in "
                 f"{DEFAULT_CONF} or the environment")
    session = os.path.expanduser(conf.get("TG_SESSION") or DEFAULT_SESSION)
    pathlib.Path(session).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    return TelegramClient(session, api_id, api_hash)


def sticker_candidates(client, cfg: BotConfig) -> list:
    """Static (webp) stickers of the configured set. Animated (.tgs) and
    video (.webm) stickers are skipped: profile photos must be still images."""
    from telethon.tl.functions.messages import GetStickerSetRequest
    from telethon.tl.types import InputStickerSetShortName

    if not cfg.sticker_set:
        return []
    res = client(GetStickerSetRequest(
        stickerset=InputStickerSetShortName(short_name=cfg.sticker_set), hash=0))
    return [d for d in res.documents if d.mime_type == "image/webp"]


def sticker_to_jpeg(client, cfg: BotConfig, doc) -> pathlib.Path:
    """Download a sticker and flatten it to a square JPEG (cached per doc id)."""
    from PIL import Image

    cache = cfg.workdir / CACHE_DIR
    cache.mkdir(exist_ok=True)
    out = cache / f"sticker-{doc.id}.jpg"
    if out.exists():
        return out
    raw = client.download_media(doc, file=bytes)
    img = Image.open(io.BytesIO(raw)).convert("RGBA")
    side = max(img.size + (512,))
    # Telegram crops to a circle; centre the sticker on a white square canvas.
    canvas = Image.new("RGB", (side, side), (255, 255, 255))
    canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)
    canvas.save(out, "JPEG", quality=92)
    return out


def local_to_uploadable(cfg: BotConfig, path: pathlib.Path) -> pathlib.Path:
    """Telegram accepts JPEG/PNG for profile photos; convert webp to JPEG."""
    if path.suffix.lower() != ".webp":
        return path
    from PIL import Image

    cache = cfg.workdir / CACHE_DIR
    cache.mkdir(exist_ok=True)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
    out = cache / f"local-{digest}.jpg"
    if not out.exists():
        Image.open(path).convert("RGB").save(out, "JPEG", quality=92)
    return out


def choose_asset(client, cfg: BotConfig, period: int):
    """Return (label, path) of this period's photo, or (None, None)."""
    local = list_local_images(cfg.dir) if cfg.source in ("local", "both") else []
    stickers: list = []
    want_stickers = cfg.source in ("telegram", "both") or (cfg.source == "local" and not local)
    if want_stickers and cfg.sticker_set:
        if client is None:
            return f"sticker-set:{cfg.sticker_set}", None
        stickers = sticker_candidates(client, cfg)

    pool = [("local", p) for p in local] + [("sticker", d) for d in stickers]
    choice = pick(pool, period, cfg.name)
    if choice is None:
        return None, None
    kind, item = choice
    if kind == "local":
        return f"local:{item.name}", local_to_uploadable(cfg, item)
    return f"sticker:{cfg.sticker_set}/{item.id}", sticker_to_jpeg(client, cfg, item)


def set_bot_photo(client, cfg: BotConfig, path: pathlib.Path, state: dict) -> dict:
    from telethon.tl.functions.photos import DeletePhotosRequest, UploadProfilePhotoRequest
    from telethon.tl.types import InputPhoto

    bot = client.get_input_entity(cfg.username)
    result = client(UploadProfilePhotoRequest(bot=bot, file=client.upload_file(str(path))))
    photo = result.photo

    prev = state.get("photo")
    if prev and not cfg.keep_history:
        try:
            client(DeletePhotosRequest(id=[InputPhoto(
                id=prev["id"], access_hash=prev["access_hash"],
                file_reference=bytes.fromhex(prev["file_reference"]))]))
        except Exception as e:  # stale file_reference etc. — not worth failing over
            log(f"{cfg.name}: could not delete previous photo: {e}")

    return {"id": photo.id, "access_hash": photo.access_hash,
            "file_reference": photo.file_reference.hex()}


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def run(args: argparse.Namespace, conf: dict[str, str]) -> int:
    bots = [b for b in discover_bots(args.workdir_glob, args.bot) if b.enabled]
    if not bots:
        log("no bots have AVATAR_ROTATE=1; nothing to do")
        return 0

    now = time.time()
    due = []
    for cfg in bots:
        if not cfg.username:
            log(f"{cfg.name}: TELEGRAM_BOT_USERNAME not set; skipping")
            continue
        period = period_index(now, cfg.interval_days)
        if not args.force and cfg.load_state().get("period") == period:
            continue
        due.append((cfg, period))

    if not due:
        log(f"all {len(bots)} rotating bot(s) up to date")
        return 0

    if args.dry_run:
        for cfg, period in due:
            label, _ = choose_asset(None, cfg, period)
            log(f"{cfg.name} (@{cfg.username}): would set {label or 'NOTHING (no assets)'}")
        return 0

    client = make_client(conf)
    client.connect()
    try:
        if not client.is_user_authorized():
            log("owner session not logged in; run: stephanie-bot-avatar.py --login")
            return 1
        failures = 0
        for cfg, period in due:
            try:
                label, path = choose_asset(client, cfg, period)
                if path is None:
                    log(f"{cfg.name}: no images in {cfg.dir} and no usable AVATAR_STICKER_SET; skipping")
                    continue
                state = cfg.load_state()
                photo = set_bot_photo(client, cfg, path, state)
                cfg.save_state({"period": period, "asset": label, "photo": photo,
                                "updated_at": datetime.now(timezone.utc).isoformat()})
                log(f"{cfg.name} (@{cfg.username}): set {label}")
            except Exception as e:
                failures += 1
                log(f"{cfg.name}: FAILED: {type(e).__name__}: {e}")
        return 1 if failures else 0
    finally:
        client.disconnect()


def login(conf: dict[str, str]) -> int:
    client = make_client(conf)
    client.start()  # prompts for phone, code, 2FA password
    me = client.get_me()
    log(f"logged in as {me.first_name} (@{me.username}); session saved")
    client.disconnect()
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--login", action="store_true", help="interactive one-time owner login")
    ap.add_argument("--dry-run", action="store_true", help="show what would change; no Telegram calls")
    ap.add_argument("--force", action="store_true", help="rotate now even if this period is done")
    ap.add_argument("--bot", action="append", help="limit to this bot (dir name or @username)")
    ap.add_argument("--workdir-glob", default=DEFAULT_WORKDIR_GLOB)
    ap.add_argument("--conf", default=DEFAULT_CONF)
    args = ap.parse_args(argv)

    conf = {**parse_env_file(pathlib.Path(args.conf)), **{
        k: v for k, v in os.environ.items() if k.startswith("TG_")}}
    return login(conf) if args.login else run(args, conf)


if __name__ == "__main__":
    sys.exit(main())
