"""Tools the `agent` job kind can call: web search/fetch and READ-ONLY
filesystem access.

Guard rails (this is reachable from Telegram):
* Filesystem is read-only and confined to HARNESS_FS_ROOTS (colon-separated,
  default: $HOME). Paths are resolved (symlinks, ..) before the check.
* Secret-looking paths are refused even inside a root: ~/.ssh, ~/.aws,
  keychains, .env files, private keys, credential stores, etc.
* fetch_url only allows http(s) to public addresses — no localhost / LAN, so
  the model can't poke at the harness API, Ollama, or your router.
* Every result is size-capped so one call can't blow the model's context.
"""
import fnmatch
import html
import ipaddress
import json
import os
import re
import socket
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

MAX_OUT = 8000
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) harness-agent/0.1"

ROOTS = [Path(p).expanduser().resolve() for p in
         os.environ.get("HARNESS_FS_ROOTS", str(Path.home())).split(":") if p.strip()]

DENY_DIRS = {".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config/gcloud", ".password-store",
             "Library/Keychains", "Library/Cookies", "Library/Mail", "Library/Messages",
             "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox"}
DENY_NAMES = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", "id_ecdsa*",
              ".netrc", ".npmrc", ".pypirc", ".git-credentials", "credentials*", "*.keychain*",
              "*secret*", "*token*", "*.sqlite-wal"]


class ToolError(Exception):
    pass


def _cap(s: str, n: int = MAX_OUT) -> str:
    return s if len(s) <= n else s[:n] + f"\n…[truncated, {len(s) - n} more chars]"


# ---- filesystem -------------------------------------------------------------

def _resolve(path: str) -> Path:
    p = Path(path).expanduser()
    if not p.is_absolute():
        p = ROOTS[0] / p
    p = p.resolve()
    if not any(p == r or r in p.parents for r in ROOTS):
        raise ToolError(f"{p} is outside the allowed roots: {', '.join(map(str, ROOTS))}")
    rel = str(p.relative_to(Path.home())) if Path.home() in p.parents else ""
    if any(rel == d or rel.startswith(d + "/") for d in DENY_DIRS) \
            or any(part in {".ssh", ".gnupg", ".aws"} for part in p.parts) \
            or any(fnmatch.fnmatch(p.name.lower(), pat) for pat in DENY_NAMES):
        raise ToolError(f"{p} looks sensitive and is blocked")
    return p


def list_dir(path: str = "~") -> str:
    p = _resolve(path)
    if not p.is_dir():
        raise ToolError(f"{p} is not a directory")
    lines = []
    for child in sorted(p.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower()))[:300]:
        try:
            if child.is_dir():
                lines.append(f"{child.name}/")
            else:
                lines.append(f"{child.name}  ({child.stat().st_size} bytes)")
        except OSError:
            lines.append(f"{child.name}  (unreadable)")
    return _cap(f"{p}\n" + "\n".join(lines))


def read_file(path: str, offset: int = 0, max_chars: int = MAX_OUT) -> str:
    if path.startswith(("http://", "https://")):  # models mix these up; be forgiving
        return fetch_url(path, max_chars)
    p = _resolve(path)
    if not p.is_file():
        raise ToolError(f"{p} is not a file")
    with open(p, "rb") as f:
        head = f.read(2048)
        if b"\0" in head:
            raise ToolError(f"{p} looks binary ({p.stat().st_size} bytes)")
        f.seek(0)
        data = f.read(offset + min(max_chars, MAX_OUT) + 1).decode("utf-8", errors="replace")
    return _cap(data[offset:], min(max_chars, MAX_OUT))


def find_files(pattern: str, root: str = "~", max_results: int = 100) -> str:
    """Glob by file name (e.g. '*.py', 'README*') under root, skipping heavy dirs."""
    base = _resolve(root)
    skip = {"node_modules", ".git", ".venv", "venv", "__pycache__", "Library", ".Trash", "dist", "build"}
    hits = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in skip and not d.startswith(".")]
        for name in filenames + dirnames:
            if fnmatch.fnmatch(name.lower(), pattern.lower()):
                hits.append(os.path.join(dirpath, name))
                if len(hits) >= max_results:
                    return "\n".join(hits) + "\n…[more results not shown]"
    return "\n".join(hits) or "no matches"


# ---- web --------------------------------------------------------------------

def _public_host(host: str) -> None:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise ToolError(f"cannot resolve {host}: {e}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ToolError(f"{host} resolves to non-public address {ip}; blocked")


def _html_to_text(s: str) -> str:
    s = re.sub(r"(?is)<(script|style|noscript|svg|head)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h[1-6]|tr)>", "\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", " ", s))
    s = re.sub(r"[ \t\r\f\v]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n\n", s).strip()


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        u = urllib.parse.urlparse(newurl)
        if u.scheme not in ("http", "https"):
            raise ToolError(f"redirect to {u.scheme} blocked")
        _public_host(u.hostname or "")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_SafeRedirect)


def fetch_url(url: str, max_chars: int = MAX_OUT) -> str:
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ToolError("only http(s) URLs are allowed")
    _public_host(u.hostname)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,text/plain,application/json,*/*"})
    with _opener.open(req, timeout=20) as res:
        ctype = res.headers.get("Content-Type", "")
        body = res.read(2_000_000).decode(res.headers.get_content_charset() or "utf-8", errors="replace")
    text = _html_to_text(body) if "html" in ctype else body
    return _cap(f"[{res.status} {ctype}] {res.url}\n\n{text}", min(max_chars, MAX_OUT))


def web_search(query: str, max_results: int = 6) -> str:
    """DuckDuckGo HTML results — no API key needed."""
    url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as res:
        page = res.read().decode("utf-8", errors="replace")
    results = []
    for m in re.finditer(
        r'(?s)<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?class="result__snippet"[^>]*>(.*?)</a>', page
    ):
        href = html.unescape(m.group(1))
        if "uddg=" in href:  # DDG wraps links in a redirect
            href = urllib.parse.unquote(urllib.parse.parse_qs(urllib.parse.urlparse(href).query)["uddg"][0])
        results.append(f"- {_html_to_text(m.group(2))}\n  {href}\n  {_html_to_text(m.group(3))}")
        if len(results) >= max_results:
            break
    return "\n".join(results) or "no results"


# ---- registry (OpenAI tool schema) -----------------------------------------

def _schema(name: str, desc: str, props: dict, required: list[str]) -> dict:
    return {"type": "function", "function": {
        "name": name, "description": desc,
        "parameters": {"type": "object", "properties": props, "required": required},
    }}


TOOLS: dict[str, tuple[Callable[..., str], dict]] = {
    "web_search": (web_search, _schema(
        "web_search", "Search the web. Returns titles, URLs and snippets.",
        {"query": {"type": "string"}}, ["query"])),
    "fetch_url": (fetch_url, _schema(
        "fetch_url", "Fetch a public web page or API URL and return its text.",
        {"url": {"type": "string"}}, ["url"])),
    "list_dir": (list_dir, _schema(
        "list_dir", f"List a directory on this computer (read-only). Allowed roots: {', '.join(map(str, ROOTS))}. "
                    "Use ~ for the home directory.",
        {"path": {"type": "string"}}, ["path"])),
    "read_file": (read_file, _schema(
        "read_file", "Read a text file on this computer (read-only). Use offset to page through long files.",
        {"path": {"type": "string"}, "offset": {"type": "integer"}}, ["path"])),
    "find_files": (find_files, _schema(
        "find_files", "Find files by name glob (e.g. '*.py', 'README*') under a directory on this computer.",
        {"pattern": {"type": "string"}, "root": {"type": "string"}}, ["pattern"])),
}


def call(name: str, arguments: Any) -> str:
    if name not in TOOLS:
        return f"error: unknown tool {name!r}"
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments or "{}")
        except json.JSONDecodeError:
            return f"error: arguments are not valid JSON: {arguments[:200]}"
        if isinstance(arguments, str):  # double-encoded
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError:
                return f"error: arguments are not valid JSON: {arguments[:200]}"
    try:
        return TOOLS[name][0](**(arguments or {}))
    except ToolError as e:
        return f"error: {e}"
    except TypeError as e:
        return f"error: bad arguments: {e}"
    except Exception as e:
        return f"error: {type(e).__name__}: {e}"
