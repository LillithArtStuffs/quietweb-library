"""Local companion server for Fieldnote Library.

Run with: python offline_server.py
Then open: http://127.0.0.1:8765/

This is a personal archive helper, not a public proxy. It listens only on
localhost and should be used for pages you are authorized to archive.
"""

from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import argparse
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen
import json
import re
import secrets
import socket
import time
from threading import Lock

HOST = "127.0.0.1"
PORT = 8765
MAX_BYTES = 8 * 1024 * 1024
BLOCKED_TAGS = {"script", "noscript", "iframe", "object", "embed", "form", "input", "button"}
ALLOWED_ATTRIBUTES = {"alt", "class", "href", "src", "title", "width", "height"}
PROJECT_ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = PROJECT_ROOT / "web"
DATA_ROOT = PROJECT_ROOT / "server_data"
LIBRARY_FILE = DATA_ROOT / "library.json"
LIBRARY_LOCK = Lock()
STARTED_AT = time.time()
ADMIN_TOKEN = secrets.token_urlsafe(18)
ANNOUNCEMENT = {"message": "", "updated": None}


def read_library():
    DATA_ROOT.mkdir(exist_ok=True)
    if not LIBRARY_FILE.exists():
        return []
    try:
        return json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


def write_library(pages):
    DATA_ROOT.mkdir(exist_ok=True)
    temporary = LIBRARY_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(pages, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(LIBRARY_FILE)


class SafeHTMLParser(HTMLParser):
    """Keep useful markup while removing executable and interactive elements."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.output = []
        self.block_depth = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in BLOCKED_TAGS:
            self.block_depth += 1
            return
        if self.block_depth:
            return
        safe_attrs = []
        for name, value in attrs:
            name = name.lower()
            if name not in ALLOWED_ATTRIBUTES or value is None:
                continue
            if name in {"href", "src"} and not value.startswith(("https://", "http://", "/", "#")):
                continue
            safe_attrs.append(f' {name}="{escape_attribute(value)}"')
        self.output.append("<" + tag + "".join(safe_attrs) + ">")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in BLOCKED_TAGS:
            self.block_depth = max(0, self.block_depth - 1)
            return
        if not self.block_depth:
            self.output.append(f"</{tag}>")

    def handle_data(self, data):
        if not self.block_depth:
            self.output.append(data)

    def handle_comment(self, data):
        return


def escape_attribute(value):
    return (str(value).replace("&", "&amp;").replace('"', "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;"))


def make_snapshot(raw_html):
    parser = SafeHTMLParser()
    parser.feed(raw_html)
    body = "".join(parser.output)
    return ("<!doctype html><html><head><meta charset=\"utf-8\">"
            "<style>body{margin:24px;font-family:system-ui,Arial,sans-serif;"
            "line-height:1.6;color:#202426}img{max-width:100%;height:auto}"
            "pre{overflow:auto;padding:12px;background:#eee}</style></head>"
            f"<body>{body}</body></html>")


def fetch_page(target):
    parsed = urlparse(target)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Only complete http:// and https:// URLs are supported.")

    request = Request(target, headers={"User-Agent": "FieldnoteOfflineArchive/1.0"})
    with urlopen(request, timeout=20) as response:
        content_type = response.headers.get_content_type()
        data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError("The page is larger than the 8 MB archive limit.")
        charset = response.headers.get_content_charset() or "utf-8"
        raw_html = data.decode(charset, errors="replace")
        snapshot = make_snapshot(raw_html)
        title_match = re.search(r"<title[^>]*>(.*?)</title>", raw_html, re.I | re.S)
        title = re.sub(r"\s+", " ", title_match.group(1)).strip() if title_match else target
        return {"title": title[:160], "snapshot": snapshot, "contentType": content_type}


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:8765")
        if self.path == "/" or self.path.startswith(("/index.html", "/app.js", "/styles.css", "/sw.js", "/manifest.webmanifest")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def send_json(self, status, value):
        payload = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def is_admin(self):
        return secrets.compare_digest(self.headers.get("X-Quietweb-Admin", ""), ADMIN_TOKEN)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/library":
            with LIBRARY_LOCK:
                self.send_json(200, {"pages": read_library()})
            return
        if parsed.path == "/api/status":
            self.send_json(200, {"ok": True, "service": "quietweb", "fetch": True, "uptime": int(time.time() - STARTED_AT), "runtime": "Python " + __import__("platform").python_version(), "port": self.server.server_address[1], "announcement": ANNOUNCEMENT})
            return
        if parsed.path == "/api/announcement":
            self.send_json(200, ANNOUNCEMENT)
            return
        if parsed.path != "/api/fetch":
            return super().do_GET()
        target = unquote(parse_qs(parsed.query).get("url", [""])[0])
        try:
            result = fetch_page(target)
            payload = json.dumps(result).encode("utf-8")
            self.send_response(200)
        except Exception as error:
            payload = json.dumps({"error": str(error)}).encode("utf-8")
            self.send_response(400)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/library":
            if not self.is_admin():
                self.send_json(403, {"error": "Invalid admin token"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length) or b"{}")
                pages = body.get("pages")
                if not isinstance(pages, list) or len(pages) > 10000:
                    raise ValueError("Library must contain a list of up to 10000 pages.")
                with LIBRARY_LOCK:
                    write_library(pages)
                self.send_json(200, {"ok": True, "count": len(pages)})
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)})
            return
        if parsed.path != "/api/admin/announcement":
            self.send_json(404, {"error": "Not found"})
            return
        if not self.is_admin():
            self.send_json(403, {"error": "Invalid admin token"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            message = str(body.get("message", "")).strip()[:240]
            ANNOUNCEMENT["message"] = message
            ANNOUNCEMENT["updated"] = int(time.time())
            self.send_json(200, ANNOUNCEMENT)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Serve Quietweb locally or on an explicitly chosen network interface.")
    parser.add_argument("--host", default=HOST, help="Bind address; use 0.0.0.0 only on a trusted network.")
    parser.add_argument("--port", type=int, default=PORT, help="Port to serve on.")
    parser.add_argument("--admin-token", default="", help="Optional fixed admin token for this server session.")
    arguments = parser.parse_args()
    if arguments.admin_token:
        ADMIN_TOKEN = arguments.admin_token
    display_host = "127.0.0.1" if arguments.host == "0.0.0.0" else arguments.host
    print(f"Quietweb Library running at http://{display_host}:{arguments.port}/")
    if arguments.host == "0.0.0.0":
        try:
            probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            probe.connect(("8.8.8.8", 80))
            lan_host = probe.getsockname()[0]
            probe.close()
            print(f"For another device on the same Wi-Fi, try: http://{lan_host}:{arguments.port}/")
        except OSError:
            print(f"Find this device's Wi-Fi IP, then open http://<ip>:{arguments.port}/ on the other device.")
        print("LAN mode is enabled. Use this only on a trusted private network.")
    print("Press Ctrl+C to stop the local archive service.")
    print(f"Admin token: {ADMIN_TOKEN}")
    handler = lambda *args, **kwargs: Handler(*args, directory=str(WEB_ROOT), **kwargs)
    ThreadingHTTPServer((arguments.host, arguments.port), handler).serve_forever()
