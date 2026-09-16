"""Local companion server for the Quietweb Library.

Run with: python offline_server.py
Then open: http://127.0.0.1:8765/

This is a personal archive helper, not a public proxy. It binds to loopback by
default and should only be exposed to a trusted private network, and only for
pages you are authorised to archive.
"""

from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen
import argparse
import ipaddress
import json
import platform
import re
import secrets
import socket
import sys
import time

HOST = "127.0.0.1"
PORT = 8765
PORT_ATTEMPTS = 8
MAX_BYTES = 8 * 1024 * 1024
MAX_BODY_BYTES = 64 * 1024 * 1024
MAX_PAGES = 10000
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
ALLOW_PRIVATE_FETCH = False


def read_library():
    DATA_ROOT.mkdir(exist_ok=True)
    if not LIBRARY_FILE.exists():
        return []
    try:
        pages = json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return pages if isinstance(pages, list) else []


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

    def handle_comment(self, data):
        return

    def handle_data(self, data):
        if not self.block_depth:
            self.output.append(data)


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


def is_private_host(hostname):
    """True when a hostname resolves only to loopback, link-local, or LAN addresses."""
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return True  # Unresolvable: treat as unsafe rather than guessing.
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if not (address.is_private or address.is_loopback or address.is_link_local or address.is_reserved):
            return False
    return True


def fetch_page(target):
    parsed = urlparse(target)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Only complete http:// and https:// URLs are supported.")
    # In LAN mode anyone on the Wi-Fi can reach this endpoint, so refuse to use
    # it as a relay into the host's own network unless that was asked for.
    if not ALLOW_PRIVATE_FETCH and is_private_host(parsed.hostname):
        raise ValueError("Refusing to fetch a private or local address. Start the server with --allow-private-fetch if that is really what you want.")

    request = Request(target, headers={"User-Agent": "QuietwebLibrary/0.4 (personal archive)"})
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
    server_version = "Quietweb/0.4"

    def allowed_origin(self):
        """Echo the caller's origin only when it is loopback or on a private network."""
        origin = self.headers.get("Origin")
        if not origin:
            return None
        parsed = urlparse(origin)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return None
        try:
            if is_private_host(parsed.hostname):
                return origin
        except ValueError:
            return None
        return None

    def end_headers(self):
        origin = self.allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        path = urlparse(self.path).path
        if path.startswith("/api/") or path in {"/", "/index.html", "/app.js", "/styles.css", "/sw.js", "/manifest.webmanifest"}:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Quietweb-Admin")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def send_json(self, status, value):
        payload = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > MAX_BODY_BYTES:
            raise ValueError("Request body is too large.")
        return json.loads(self.rfile.read(length) or b"{}")

    def is_admin(self):
        return secrets.compare_digest(self.headers.get("X-Quietweb-Admin", ""), ADMIN_TOKEN)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/library":
            with LIBRARY_LOCK:
                self.send_json(200, {"pages": read_library()})
            return
        if parsed.path == "/api/status":
            self.send_json(200, {
                "ok": True,
                "service": "quietweb",
                "version": "0.4",
                "fetch": True,
                "uptime": int(time.time() - STARTED_AT),
                "runtime": "Python " + platform.python_version(),
                "port": self.server.server_address[1],
                "announcement": ANNOUNCEMENT,
            })
            return
        if parsed.path == "/api/announcement":
            self.send_json(200, ANNOUNCEMENT)
            return
        if parsed.path != "/api/fetch":
            return super().do_GET()
        target = unquote(parse_qs(parsed.query).get("url", [""])[0])
        try:
            self.send_json(200, fetch_page(target))
        except Exception as error:
            self.send_json(400, {"error": str(error)})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path not in {"/api/library", "/api/admin/announcement"}:
            self.send_json(404, {"error": "Not found"})
            return
        if not self.is_admin():
            self.send_json(403, {"error": "Invalid admin token"})
            return
        try:
            body = self.read_json_body()
            if parsed.path == "/api/library":
                pages = body.get("pages")
                if not isinstance(pages, list) or len(pages) > MAX_PAGES:
                    raise ValueError(f"Library must contain a list of up to {MAX_PAGES} pages.")
                if any(not isinstance(page, dict) or not page.get("id") for page in pages):
                    raise ValueError("Every page needs an id.")
                with LIBRARY_LOCK:
                    write_library(pages)
                self.send_json(200, {"ok": True, "count": len(pages)})
                return
            message = str(body.get("message", "")).strip()[:240]
            ANNOUNCEMENT["message"] = message
            ANNOUNCEMENT["updated"] = int(time.time())
            self.send_json(200, ANNOUNCEMENT)
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})


def local_ip():
    """Best guess at the address another device on the same Wi-Fi should use."""
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("192.0.2.1", 80))  # TEST-NET-1: routed nowhere, sends nothing.
        address = probe.getsockname()[0]
        probe.close()
        return address
    except OSError:
        return None


def serve(host, port):
    """Bind the first free port at or after the requested one."""
    handler = lambda *args, **kwargs: Handler(*args, directory=str(WEB_ROOT), **kwargs)
    last_error = None
    for offset in range(PORT_ATTEMPTS):
        try:
            return ThreadingHTTPServer((host, port + offset), handler)
        except OSError as error:
            last_error = error
    raise SystemExit(f"Could not bind {host}:{port}-{port + PORT_ATTEMPTS - 1}. Last error: {last_error}")


def main():
    global ADMIN_TOKEN, ALLOW_PRIVATE_FETCH
    parser = argparse.ArgumentParser(description="Serve Quietweb locally or on an explicitly chosen network interface.")
    parser.add_argument("--host", default=HOST, help="Bind address; use 0.0.0.0 only on a trusted network.")
    parser.add_argument("--port", type=int, default=PORT, help="Port to serve on; the next free port is used if it is busy.")
    parser.add_argument("--admin-token", default="", help="Optional fixed admin token for this server session.")
    parser.add_argument("--allow-private-fetch", action="store_true", help="Permit archiving private/LAN addresses. Off by default.")
    arguments = parser.parse_args()

    if arguments.admin_token:
        if len(arguments.admin_token) < 12:
            raise SystemExit("--admin-token must be at least 12 characters.")
        ADMIN_TOKEN = arguments.admin_token
    ALLOW_PRIVATE_FETCH = arguments.allow_private_fetch

    httpd = serve(arguments.host, arguments.port)
    port = httpd.server_address[1]
    display_host = "127.0.0.1" if arguments.host in {"0.0.0.0", "::"} else arguments.host
    print(f"Quietweb Library running at http://{display_host}:{port}/")
    if port != arguments.port:
        print(f"(port {arguments.port} was busy, so {port} was used instead)")
    if arguments.host in {"0.0.0.0", "::"}:
        address = local_ip()
        if address:
            print(f"For another device on the same Wi-Fi, try: http://{address}:{port}/")
        else:
            print(f"Find this device's Wi-Fi IP, then open http://<ip>:{port}/ on the other device.")
        print("LAN mode is enabled. Use this only on a trusted private network.")
    print(f"Admin token: {ADMIN_TOKEN}")
    print("Press Ctrl+C to stop the local archive service.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Quietweb.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
