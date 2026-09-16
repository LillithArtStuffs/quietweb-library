"""End-to-end checks for Quietweb, with no browser required.

Boots the real server on a throwaway port against a temporary data directory,
exercises every endpoint, and validates the static app files. Useful when you
are on a device where you cannot open devtools.

    python scripts/selftest.py
"""

from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
import json
import re
import struct
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
sys.path.insert(0, str(ROOT / "server"))

import offline_server  # noqa: E402  (path is set up immediately above)

RESULTS = []


def check(name):
    """Decorator that records a pass/fail line instead of aborting the run."""
    def wrap(function):
        try:
            detail = function()
            RESULTS.append((True, name, detail or "ok"))
        except Exception as error:
            RESULTS.append((False, name, f"{type(error).__name__}: {error}"))
        return function
    return wrap


def request(base, path, method="GET", body=None, token=None, expect=200):
    headers = {}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["X-Quietweb-Admin"] = token
    call = Request(base + path, data=data, headers=headers, method=method)
    try:
        with urlopen(call, timeout=10) as response:
            status, payload = response.status, response.read()
            content_type = response.headers.get_content_type()
    except HTTPError as error:
        status, payload = error.code, error.read()
        content_type = error.headers.get_content_type()
    if status != expect:
        raise AssertionError(f"{method} {path} returned {status}, expected {expect}: {payload[:200]!r}")
    return status, payload, content_type


def json_body(payload):
    return json.loads(payload.decode("utf-8"))


def png_size(path):
    header = path.read_bytes()[:24]
    if header[:8] != b"\x89PNG\r\n\x1a\n":
        raise AssertionError(f"{path.name} is not a PNG")
    return struct.unpack(">II", header[16:24])


def run():
    data_root = Path(tempfile.mkdtemp(prefix="quietweb-selftest-"))
    offline_server.DATA_ROOT = data_root
    offline_server.LIBRARY_FILE = data_root / "library.json"
    token = "selftest-token-0123456789"
    offline_server.ADMIN_TOKEN = token

    handler = lambda *args, **kwargs: offline_server.Handler(*args, directory=str(WEB), **kwargs)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    try:
        @check("static app files are served")
        def _():
            served = []
            for name in ("index.html", "app.js", "styles.css", "sw.js", "manifest.webmanifest",
                         "icons/quietweb.svg", "icons/quietweb-192.png", "icons/quietweb-512.png"):
                request(base, "/" + name)
                served.append(name)
            return f"{len(served)} files"

        @check("manifest is installable")
        def _():
            manifest = json_body(request(base, "/manifest.webmanifest")[1])
            assert manifest.get("name") and manifest.get("start_url"), "missing name or start_url"
            icons = manifest.get("icons") or []
            assert icons, "no icons declared, so no browser will offer to install it"
            sizes = {icon.get("sizes") for icon in icons}
            assert "192x192" in sizes and "512x512" in sizes, f"needs 192 and 512 icons, has {sizes}"
            assert any(icon.get("purpose") == "maskable" for icon in icons), "no maskable icon"
            for icon in icons:
                request(base, "/" + icon["src"])
            return f"{len(icons)} icons, all reachable"

        @check("png icons have the declared dimensions")
        def _():
            for size in (192, 512):
                actual = png_size(WEB / "icons" / f"quietweb-{size}.png")
                assert actual == (size, size), f"quietweb-{size}.png is {actual}"
            return "192x192 and 512x512"

        @check("every element app.js looks up exists in index.html")
        def _():
            html = (WEB / "index.html").read_text(encoding="utf-8")
            app = (WEB / "app.js").read_text(encoding="utf-8")
            declared = set(re.findall(r'id="([^"]+)"', html))
            used = set(re.findall(r'\$\("([^"]+)"\)', app))
            missing = sorted(used - declared)
            assert not missing, f"missing ids: {missing}"
            return f"{len(used)} lookups resolved"

        @check("every theme defines every colour token")
        def _():
            css = (WEB / "styles.css").read_text(encoding="utf-8")
            blocks = re.findall(r'(?:^:root|html\[data-theme="([a-z]+)"\]) \{(.*?)\}', css, re.S | re.M)
            assert len(blocks) >= 2, "no theme blocks found"
            named = [(name or "light", set(re.findall(r"--([a-z-]+)\s*:", body))) for name, body in blocks]
            reference = set().union(*(tokens for _, tokens in named))
            for name, tokens in named:
                missing = sorted(reference - tokens)
                assert not missing, f"theme '{name}' is missing {missing}"
            return f"{len(named)} themes x {len(reference)} tokens"

        @check("no colour is hardcoded outside a theme block")
        def _():
            offenders = []
            for number, line in enumerate((WEB / "styles.css").read_text(encoding="utf-8").split("\n"), 1):
                if "data-theme" in line or line.strip().startswith("--"):
                    continue
                if re.search(r"#[0-9a-fA-F]{3,6}\b", line):
                    offenders.append(f"{number}: {line.split('{')[0].strip()[:40]}")
            assert not offenders, "hardcoded colours: " + "; ".join(offenders[:5])
            return "all colours come from tokens"

        @check("every theme the app offers has a stylesheet block")
        def _():
            css = (WEB / "styles.css").read_text(encoding="utf-8")
            app = (WEB / "app.js").read_text(encoding="utf-8")
            html = (WEB / "index.html").read_text(encoding="utf-8")
            declared = set(re.findall(r'html\[data-theme="([a-z]+)"\]\s*\{', css)) | {"light"}
            listed = set(re.findall(r'const THEMES = \[([^\]]+)\]', app)[0].replace('"', "").replace(" ", "").split(","))
            picker = re.search(r'<select id="themeSelect".*?</select>', html, re.S).group(0)
            offered = set(re.findall(r'<option value="([a-z]+)"', picker)) - {"system"}
            assert listed <= declared, f"app.js offers themes with no CSS: {sorted(listed - declared)}"
            assert offered == listed, f"the picker and app.js disagree: {sorted(offered ^ listed)}"
            colours = set(re.findall(r'(\w+): "#', re.search(r'const THEME_COLORS = \{([^}]+)\}', app).group(1)))
            assert colours == listed, f"THEME_COLORS is missing {sorted(listed - colours)}"
            return f"{len(listed)} themes: {', '.join(sorted(listed))}"

        @check("service worker never caches live server state")
        def _():
            worker = (WEB / "sw.js").read_text(encoding="utf-8")
            assert '"/api/"' in worker or "'/api/'" in worker, "no /api/ bypass found in sw.js"
            assert "networkFirst" in worker, "shell is not network-first, so updates would never land"
            return "api bypass and network-first shell present"

        @check("status endpoint reports a live server")
        def _():
            status = json_body(request(base, "/api/status")[1])
            assert status["ok"] and status["service"] == "quietweb", status
            assert isinstance(status["uptime"], int), "uptime is not a number"
            assert "announcement" in status, "status has no announcement field"
            return f"version {status.get('version')} on {status['runtime']}"

        @check("library starts empty")
        def _():
            assert json_body(request(base, "/api/library")[1]) == {"pages": []}
            return "no pages"

        @check("library writes require the admin token")
        def _():
            request(base, "/api/library", "POST", {"pages": []}, expect=403)
            request(base, "/api/library", "POST", {"pages": []}, token="wrong-token", expect=403)
            return "rejected anonymous and wrong tokens"

        @check("library round-trips with the admin token")
        def _():
            pages = [{"id": "page-1", "title": "Test", "content": "body", "tag": "t", "type": "note"}]
            result = json_body(request(base, "/api/library", "POST", {"pages": pages}, token=token)[1])
            assert result["count"] == 1, result
            stored = json_body(request(base, "/api/library")[1])["pages"]
            assert stored == pages, stored
            return "saved and read back 1 page"

        @check("malformed libraries are rejected")
        def _():
            request(base, "/api/library", "POST", {"pages": "nope"}, token=token, expect=400)
            request(base, "/api/library", "POST", {"pages": [{"title": "no id"}]}, token=token, expect=400)
            return "rejected a non-list and an id-less page"

        @check("announcements broadcast and clear")
        def _():
            result = json_body(request(base, "/api/admin/announcement", "POST", {"message": "hello"}, token=token)[1])
            assert result["message"] == "hello", result
            assert json_body(request(base, "/api/status")[1])["announcement"]["message"] == "hello"
            request(base, "/api/admin/announcement", "POST", {"message": ""}, token=token)
            assert json_body(request(base, "/api/status")[1])["announcement"]["message"] == ""
            return "set and cleared"

        @check("announcements require the admin token")
        def _():
            request(base, "/api/admin/announcement", "POST", {"message": "nope"}, expect=403)
            return "rejected anonymous broadcast"

        @check("fetch refuses non-http schemes and private targets")
        def _():
            for target in ("ftp://example.com", "file:///etc/passwd", "http://127.0.0.1:1/", "http://192.168.0.1/"):
                _, payload, _ = request(base, "/api/fetch?url=" + quote(target, safe=""), expect=400)
                assert "error" in json_body(payload), payload
            return "blocked 4 unsafe targets"

        @check("unknown api routes 404 instead of writing files")
        def _():
            request(base, "/api/nonsense", "POST", {}, token=token, expect=404)
            return "404 as expected"

        @check("snapshots strip scripts and handlers")
        def _():
            snapshot = offline_server.make_snapshot(
                '<html><body><h1 onclick="x()">Hi</h1><script>alert(1)</script>'
                '<p>keep</p><iframe src="http://evil"></iframe></body></html>')
            for banned in ("<script", "alert(1)", "onclick", "<iframe"):
                assert banned not in snapshot, f"{banned} survived sanitising"
            assert "keep" in snapshot, "readable text was dropped"
            return "scripts, handlers, and frames removed"

        @check("security headers are present")
        def _():
            _, _, _ = request(base, "/api/status")
            call = Request(base + "/api/status")
            with urlopen(call, timeout=10) as response:
                assert response.headers.get("X-Content-Type-Options") == "nosniff", "missing nosniff"
                assert response.headers.get("Cache-Control") == "no-store", "api responses are cacheable"
            return "nosniff and no-store set"
    finally:
        httpd.shutdown()
        httpd.server_close()

    width = max(len(name) for _, name, _ in RESULTS)
    for passed, name, detail in RESULTS:
        print(f"{'PASS' if passed else 'FAIL'}  {name.ljust(width)}  {detail}")
    failed = [name for passed, name, _ in RESULTS if not passed]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(run())
