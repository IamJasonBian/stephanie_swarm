#!/usr/bin/env python3
"""
frontend — "Coach in a Cave" negotiation & application assistant.

Serves the single-page UI and proxies chat to the swarm's compute service
(:8878), which is OpenAI-compatible with model aliases hermes | claude | kimi
and injects the negotiation.md base prompt into every chat. Compute is
non-streaming (v1), so this proxy converts each reply into the SSE stream the
frontend expects — swap in real pass-through streaming when compute grows it.

Env:
  HOST          bind host              (default 127.0.0.1)
  PORT          bind port              (default 8879)
  COMPUTE_URL   compute service        (default http://localhost:8878)
  LLM_MODEL     default model alias    (default hermes)

Run:  python3 server.py   then open http://localhost:8879
"""
import json
import os
import sys
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8879"))
COMPUTE_URL = os.environ.get("COMPUTE_URL", "http://localhost:8878").rstrip("/")
DEFAULT_MODEL = os.environ.get("LLM_MODEL", "hermes")

HERE = Path(__file__).resolve().parent
INDEX = HERE / "index.html"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---- helpers -------------------------------------------------------
    def _send(self, code, body=b"", ctype="application/json", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # ---- routes --------------------------------------------------------
    def do_GET(self):
        if self.path == "/" or self.path.startswith("/index.html"):
            try:
                self._send(200, INDEX.read_bytes(), "text/html; charset=utf-8")
            except FileNotFoundError:
                self._send(500, b"index.html missing", "text/plain")
        elif self.path == "/health":
            self._send(200, json.dumps({"ok": True, "model": DEFAULT_MODEL, "compute": COMPUTE_URL}))
        elif self.path == "/cave.jpg":
            # dark cave wallpaper (dharmx/walls, basalt collection), resized
            try:
                self._send(200, (HERE / "cave_web.jpg").read_bytes(), "image/jpeg",
                           {"Cache-Control": "max-age=86400"})
            except FileNotFoundError:
                self._send(404, json.dumps({"error": "no cave image"}))
        elif self.path == "/api/models":
            self._models()
        else:
            self._send(404, json.dumps({"error": "not found"}))

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        if self.path == "/api/chat":
            self._chat()
        else:
            self._send(404, json.dumps({"error": "not found"}))

    def _models(self):
        # compute's /v1/models lists the aliases: hermes | claude | kimi
        try:
            with urllib.request.urlopen(COMPUTE_URL + "/v1/models", timeout=5) as r:
                data = json.loads(r.read())
            names = [m.get("id") for m in data.get("data", []) if m.get("id")]
        except Exception:
            names = []
        if DEFAULT_MODEL not in names:
            names.insert(0, DEFAULT_MODEL)
        self._send(200, json.dumps({"models": names, "default": DEFAULT_MODEL}))

    def _chat(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._send(400, json.dumps({"error": "bad json"}))
            return

        upstream_body = json.dumps({
            "model": payload.get("model") or DEFAULT_MODEL,
            "messages": payload.get("messages", []),
            "temperature": payload.get("temperature", 0.6),
        }).encode("utf-8")

        req = urllib.request.Request(
            COMPUTE_URL + "/v1/chat/completions",
            data=upstream_body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        # compute is non-streaming (v1): take the full reply, then emit it as
        # the SSE chunk stream the frontend's reader already understands.
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                result = json.loads(r.read())
            content = result["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            self._send(502, json.dumps({"error": "compute error", "detail": e.read().decode("utf-8", "ignore")}))
            return
        except Exception as e:
            self._send(502, json.dumps({"error": "cannot reach compute", "detail": str(e)}))
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            # chunk by ~lines so the UI still "types" instead of slamming in
            for piece in content.splitlines(keepends=True) or [content]:
                evt = json.dumps({"choices": [{"delta": {"content": piece}}]})
                self.wfile.write(("data: " + evt + "\n\n").encode("utf-8"))
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    if not INDEX.exists():
        print(f"WARNING: {INDEX} not found — the UI won't load.", file=sys.stderr)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Coach in a Cave → http://{HOST}:{PORT}")
    print(f"  compute : {COMPUTE_URL}")
    print(f"  model   : {DEFAULT_MODEL}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
        srv.shutdown()


if __name__ == "__main__":
    main()
