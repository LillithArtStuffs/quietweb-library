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
import ipaddress
import json
import re
import shutil
import struct
import sys
import tempfile
import time

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
            blocks = re.findall(r'(?:^:root|html\[data-theme="([a-z][a-z0-9-]*)"\]) \{(.*?)\}', css, re.S | re.M)
            assert len(blocks) >= 2, "no theme blocks found"
            named = [(name or "light", set(re.findall(r"--([a-z-]+)\s*:", body))) for name, body in blocks]
            reference = set().union(*(tokens for _, tokens in named))
            for name, tokens in named:
                missing = sorted(reference - tokens)
                assert not missing, f"theme '{name}' is missing {missing}"
            return f"{len(named)} themes x {len(reference)} tokens"

        @check("no colour is hardcoded outside a theme block")
        def _():
            # Blank out comments first, keeping line numbers: a hex quoted in a
            # comment documents a source, it does not paint anything.
            css = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)),
                         (WEB / "styles.css").read_text(encoding="utf-8"), flags=re.S)
            offenders = []
            for number, line in enumerate(css.split("\n"), 1):
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
            declared = set(re.findall(r'html\[data-theme="([a-z][a-z0-9-]*)"\]\s*\{', css)) | {"light"}
            listed = set(re.findall(r'const THEMES = \[([^\]]+)\]', app)[0].replace('"', "").replace(" ", "").split(","))
            picker = re.search(r'<select id="themeSelect".*?</select>', html, re.S).group(0)
            offered = set(re.findall(r'<option value="([a-z][a-z0-9-]*)"', picker)) - {"system"}
            assert listed <= declared, f"app.js offers themes with no CSS: {sorted(listed - declared)}"
            assert offered == listed, f"the picker and app.js disagree: {sorted(offered ^ listed)}"
            colours = set(re.findall(r'"?([a-z][a-z0-9-]*)"?: "#', re.search(r'const THEME_COLORS = \{([^}]+)\}', app).group(1)))
            assert colours == listed, f"THEME_COLORS is missing {sorted(listed - colours)}"
            labels = set(re.findall(r'"?([a-z][a-z0-9-]*)"?:\s*"', re.search(r"const THEME_LABELS = \{(.*?)\n\};", app, re.S).group(1)))
            assert listed <= labels, f"THEME_LABELS is missing {sorted(listed - labels)}"
            # The editor's base list has to offer every theme too.
            bases = re.search(r'<select id="themeBase">.*?</select>', html, re.S).group(0)
            offered_bases = set(re.findall(r'<option value="([a-z][a-z0-9-]*)"', bases))
            assert offered_bases == listed, f"the editor's base list disagrees: {sorted(offered_bases ^ listed)}"
            return f"{len(listed)} themes: {', '.join(sorted(listed))}"

        @check("every highlight class the app emits has a style")
        def _():
            app = (WEB / "app.js").read_text(encoding="utf-8")
            css = (WEB / "styles.css").read_text(encoding="utf-8")
            grammars = re.findall(r'\["(\w+)", String\.raw', app)
            emitted = set(grammars) - {"word"}
            emitted |= {"keyword", "builtin", "function"}  # what "word" is reclassified into
            styled = set(re.findall(r"\.syn-([a-z]+)", css))
            assert emitted <= styled, f"emitted but unstyled: {sorted(emitted - styled)}"
            assert styled <= emitted, f"styled but never emitted: {sorted(styled - emitted)}"
            return f"{len(emitted)} token classes"

        @check("the theme editor exposes exactly the stylesheet's tokens")
        def _():
            css = (WEB / "styles.css").read_text(encoding="utf-8")
            app = (WEB / "app.js").read_text(encoding="utf-8")
            root = re.search(r":root \{(.*?)\n\}", css, re.S).group(1)
            declared = set(re.findall(r"--([a-z-]+)\s*:", root))
            groups = re.search(r"const TOKEN_GROUPS = \[(.*?)\n\];", app, re.S).group(1)
            # Group labels are capitalised, so a lowercase match is always a token.
            editable = re.findall(r'"([a-z][a-z-]*)"', groups)
            duplicated = sorted({name for name in editable if editable.count(name) > 1})
            assert not duplicated, f"the editor lists these twice: {duplicated}"
            listed = set(editable)
            missing = sorted(declared - listed)
            extra = sorted(listed - declared)
            assert not missing, f"the editor cannot reach: {missing}"
            assert not extra, f"the editor offers tokens the stylesheet has no use for: {extra}"
            return f"{len(declared)} tokens editable"

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

        @check("a short secret is refused")
        def _():
            # Called directly rather than by launching the server: a-Shell has no
            # fork(), so a test that shells out cannot run on the phone, which is
            # where this suite earns its keep.
            for flag, value, advice in [("--proxy-passphrase", "1", " use --no-proxy-auth"),
                                        ("--admin-token", "short", "")]:
                try:
                    offline_server.reject_short_secret(flag, value, advice)
                except SystemExit as refusal:
                    assert "at least 12" in str(refusal), refusal
                    if advice:
                        assert "--no-proxy-auth" in str(refusal), "no advice on what to do instead"
                else:
                    raise AssertionError(f"{flag} accepted {value!r}")
            # A long one, and an empty one meaning "generate it", both pass.
            offline_server.reject_short_secret("--proxy-passphrase", "a-long-enough-secret")
            offline_server.reject_short_secret("--proxy-passphrase", "")
            return "short refused, long and unset accepted"

        @check("a tailnet address is recognised but not called Wi-Fi")
        def _():
            # Tailscale's range is its own thing: reachable from anywhere on the
            # tailnet, not by a device merely on the same Wi-Fi.
            for address, tailnet in [("100.64.0.1", True), ("100.100.100.100", True),
                                     ("100.127.255.254", True), ("100.128.0.1", False),
                                     ("99.64.0.1", False), ("192.168.1.5", False)]:
                found = ipaddress.ip_address(address)
                assert (found in offline_server.TAILNET) is tailnet, f"{address} tailnet={not tailnet}"
                if tailnet:
                    assert not any(found in net for net in offline_server.LAN_NETWORKS), \
                        f"{address} was also counted as Wi-Fi, which it is not"
            return "6 addresses, tailnet kept separate from LAN"

        @check("the tailnet probe reports nothing when there is no tailnet")
        def _():
            # It probes toward Tailscale's service address; with no tailnet the
            # kernel answers with the default route, which must be rejected.
            found = offline_server.tailnet_ip()
            assert found is None or ipaddress.ip_address(found) in offline_server.TAILNET, \
                f"reported {found}, which is not a tailnet address"
            return "no tailnet here, and nothing invented"

        @check("only a reachable LAN address is offered to other devices")
        def _():
            import ipaddress
            # ipaddress calls 192.0.0.2 private, but nothing can route to it;
            # on cellular that is exactly what the probe returns.
            for address, reachable in [("192.0.0.2", False), ("169.254.3.4", False), ("100.64.0.1", False),
                                       ("192.168.1.50", True), ("10.0.0.5", True), ("172.20.1.1", True)]:
                counted = any(ipaddress.ip_address(address) in net for net in offline_server.LAN_NETWORKS)
                assert counted is reachable, f"{address} counted as LAN={counted}"
            return "6 addresses classified, special-use ranges excluded"

        @check("a reader closing the tab does not print a traceback")
        def _():
            import contextlib
            import io
            server = offline_server.Server.__new__(offline_server.Server)
            captured = io.StringIO()
            try:
                raise BrokenPipeError(32, "Broken pipe")
            except BrokenPipeError:
                with contextlib.redirect_stderr(captured):
                    server.handle_error(None, ("127.0.0.1", 1))
            assert captured.getvalue() == "", f"noisy on disconnect: {captured.getvalue()[:120]}"
            # A real fault still has to be reported.
            try:
                raise RuntimeError("something actually broke")
            except RuntimeError:
                with contextlib.redirect_stderr(captured):
                    server.handle_error(None, ("127.0.0.1", 1))
            assert "something actually broke" in captured.getvalue(), "real errors were swallowed too"
            return "silent on disconnect, still loud on real faults"

        @check("the self-test itself spawns no processes")
        def _():
            # iOS has no fork(). A check that shells out passes here and fails on
            # the phone, which is the one place this suite is irreplaceable.
            # Look for calls, not the word: other checks discuss subprocesses.
            source = Path(__file__).read_text(encoding="utf-8")
            code = "\n".join(line for line in source.split("\n") if not line.lstrip().startswith("#"))
            spawns = re.findall(r"^\s*import subprocess|\bsubprocess\.\w+\(|\bos\.(?:system|fork|spawn\w*|popen)\(", code, re.M)
            assert not spawns, f"the suite spawns processes: {sorted(set(spawns))}"
            return "no fork, so it runs anywhere Python does"

        @check("the a-Shell launcher runs the server without a subprocess")
        def _():
            raw = (ROOT / "scripts" / "start-ashell.sh").read_text(encoding="utf-8")
            # Judge what the script runs, not what it says about itself: the
            # comment explaining this rule names start.py too.
            script = "\n".join(line for line in raw.split("\n") if not line.lstrip().startswith("#"))
            # iOS has no fork(), so a server started as a child does not
            # reliably receive Ctrl+C and keeps holding the port.
            assert "start.py" not in script, "the a-Shell launcher still goes through start.py"
            assert "server/offline_server.py" in script, "it does not start the server directly"
            assert "exec " in script, "it does not exec, so the shell stays between Ctrl+C and the server"
            return "starts the server directly and execs into it"

        @check("literal addresses are judged without asking the resolver")
        def _():
            import socket as socket_module
            original = socket_module.getaddrinfo

            def refuse(*args, **kwargs):
                raise AssertionError("the resolver was consulted for a literal address")

            socket_module.getaddrinfo = refuse
            try:
                for host, private in [("127.0.0.1", True), ("192.168.0.1", True), ("10.0.0.5", True),
                                      ("169.254.1.1", True), ("::1", True),
                                      ("8.8.8.8", False), ("2001:4860:4860::8888", False)]:
                    actual = offline_server.is_private_host(host)
                    assert actual is private, f"{host} judged private={actual}, expected {private}"
            finally:
                socket_module.getaddrinfo = original
            return "7 literals, no DNS"

        @check("a stalled resolver cannot hang a request")
        def _():
            import socket as socket_module
            original = socket_module.getaddrinfo
            original_timeout = offline_server.RESOLVE_TIMEOUT

            def stall(*args, **kwargs):
                time.sleep(30)

            socket_module.getaddrinfo = stall
            offline_server.RESOLVE_TIMEOUT = 0.4
            started = time.time()
            try:
                offline_server.is_private_host("example.invalid")
                raise AssertionError("a stalled resolver was treated as a successful lookup")
            except ValueError as error:
                assert "Could not resolve" in str(error), error
            finally:
                socket_module.getaddrinfo = original
                offline_server.RESOLVE_TIMEOUT = original_timeout
            elapsed = time.time() - started
            assert elapsed < 5, f"took {elapsed:.1f}s to give up"
            return f"gave up after {elapsed:.1f}s instead of blocking"

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
        # ---- live browsing proxy -------------------------------------------
        import functools
        import http.server
        import socketserver
        import browse

        site_handler = functools.partial(http.server.SimpleHTTPRequestHandler,
                                         directory=str(ROOT / "scripts" / "browser" / "fixture" / "site"))
        site = socketserver.TCPServer(("127.0.0.1", 0), site_handler)
        site.daemon_threads = True
        Thread(target=site.serve_forever, daemon=True).start()
        site_base = f"http://127.0.0.1:{site.server_address[1]}"
        origin = offline_server.ALLOW_PRIVATE_FETCH
        offline_server.ALLOW_PRIVATE_FETCH = True  # the fixture lives on loopback

        def proxy_path(url):
            return browse.PREFIX + browse.encode_target(url)

        try:
            @check("the proxy refuses private targets by default")
            def _():
                offline_server.ALLOW_PRIVATE_FETCH = False
                try:
                    _, payload, _ = request(base, proxy_path(site_base + "/index.html"), expect=502)
                    assert b"private or local address" in payload, payload[:200]
                finally:
                    offline_server.ALLOW_PRIVATE_FETCH = True
                return "refused a loopback target"

            @check("the proxy rewrites every address back through itself")
            def _():
                _, payload, content_type = request(base, proxy_path(site_base + "/index.html"))
                page = payload.decode("utf-8")
                assert content_type == "text/html", content_type
                # The address bar shows the real URL on purpose, so check the
                # document below it: nothing there may still point at the origin.
                document = page.split(">Library</a></div>", 1)[-1]
                assert site_base not in document, "an un-rewritten absolute URL to the origin survived"
                for marker, target in [
                    ("relative link", site_base + "/about.html"),
                    ("root-relative link", site_base + "/sub/deep.html"),
                    ("absolute link", "https://example.com/outside"),
                    ("relative image", site_base + "/pic.png"),
                    ("stylesheet", site_base + "/style.css"),
                ]:
                    assert proxy_path(target) in page, f"{marker} was not rewritten ({target})"
                return "links, images and stylesheet all routed through /p/"

            @check("the proxy leaves addresses it should not touch alone")
            def _():
                page = request(base, proxy_path(site_base + "/index.html"))[1].decode("utf-8")
                assert 'href="#section"' in page, "an in-page anchor was rewritten"
                assert 'href="mailto:someone@example.com"' in page, "a mailto: was rewritten"
                assert "data:image/gif" in request(base, proxy_path(site_base + "/style.css"))[1].decode("utf-8")
                return "anchors, mailto: and data: left as they were"

            @check("relative addresses resolve against the real page, not the proxy")
            def _():
                page = request(base, proxy_path(site_base + "/sub/deep.html"))[1].decode("utf-8")
                # ../pic.png from /sub/ is /pic.png, not /sub/pic.png.
                assert proxy_path(site_base + "/pic.png") in page, "../pic.png resolved wrongly"
                assert proxy_path(site_base + "/style.css") in page, "../style.css resolved wrongly"
                assert proxy_path(site_base + "/sub/pic.png") not in page, "resolved against the wrong directory"
                return "../ resolved against the source directory"

            @check("stylesheets are rewritten too")
            def _():
                _, payload, content_type = request(base, proxy_path(site_base + "/style.css"))
                sheet = payload.decode("utf-8")
                assert content_type == "text/css", content_type
                assert proxy_path(site_base + "/pic.png") in sheet, "url() was not rewritten"
                assert proxy_path(site_base + "/theme.css") in sheet, "@import was not rewritten"
                return "url() and @import both routed"

            @check("binary responses pass through untouched")
            def _():
                _, payload, content_type = request(base, proxy_path(site_base + "/pic.png"))
                assert content_type == "image/png", content_type
                original = (ROOT / "scripts" / "browser" / "fixture" / "site" / "pic.png").read_bytes()
                assert payload == original, f"{len(payload)} bytes back, {len(original)} expected"
                return f"{len(payload)} bytes identical"

            @check("srcset candidates keep their descriptors")
            def _():
                page = request(base, proxy_path(site_base + "/index.html"))[1].decode("utf-8")
                assert f'srcset="{proxy_path(site_base + "/pic.png")} 1x, {proxy_path(site_base + "/pic.png")} 2x"' in page, \
                    "srcset was not rewritten with its descriptors intact"
                return "1x and 2x preserved"

            @check("scripts are kept by default and removed on request")
            def _():
                page = request(base, proxy_path(site_base + "/index.html"))[1].decode("utf-8")
                assert proxy_path(site_base + "/app.js") in page, "the script was dropped by default"
                assert "integrity=" not in page, "an integrity attribute survived, which would block the proxied file"
                assert "crossorigin=" not in page, "a crossorigin attribute survived"
                offline_server.KEEP_SCRIPTS = False
                try:
                    stripped = request(base, proxy_path(site_base + "/index.html"))[1].decode("utf-8")
                    assert "<script" not in stripped, "a script survived --strip-scripts"
                    assert "Fixture Site" in stripped, "stripping scripts took the page with it"
                finally:
                    offline_server.KEEP_SCRIPTS = True
                return "kept by default, gone with --strip-scripts"

            @check("the address bar is injected and can navigate")
            def _():
                page = request(base, proxy_path(site_base + "/index.html"))[1].decode("utf-8")
                assert 'id="quietweb-bar"' in page, "no address bar was injected"
                assert page.index('id="quietweb-bar"') < page.index("<h1>"), "the bar landed after the page content"
                # urlopen follows the redirect, so a 200 carrying the About page
                # is the proof that /p/go pointed somewhere real.
                _, landed, _ = request(base, "/p/go?url=" + quote(site_base + "/about.html", safe=""))
                assert b"<h1>About</h1>" in landed, landed[:200]
                assert b"quietweb-bar" in landed, "the bar is missing after navigating"
                return "bar injected at the top of <body>, /p/go navigates"

            @check("/p/ offers somewhere to start")
            def _():
                _, payload, content_type = request(base, "/p/")
                assert content_type == "text/html", content_type
                assert b"quietweb-bar" in payload, "the start page has no address bar"
                assert b"Browse through Quietweb" in payload, payload[:200]
                return "start page served"

            @check("a dead target explains itself instead of hanging")
            def _():
                _, payload, _ = request(base, proxy_path("http://127.0.0.1:1/gone"), expect=502)
                assert b"Could not load that page" in payload, payload[:200]
                assert b"quietweb-bar" in payload, "the error page has no way back"
                return "502 with the address bar intact"
            # ---- proxy passphrase gate ----------------------------------------
            import http.client
            import gate as gatekeeper

            def raw(path, method="GET", body=None, cookie=None):
                """A request that does not follow redirects and can carry a cookie."""
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=10)
                headers = {}
                if cookie:
                    headers["Cookie"] = cookie
                if body is not None:
                    headers["Content-Type"] = "application/x-www-form-urlencoded"
                connection.request(method, path, body=body, headers=headers)
                response = connection.getresponse()
                payload = response.read()
                result = (response.status, payload, response.getheader("Set-Cookie"), response.getheader("Location"))
                connection.close()
                return result

            offline_server.GATE = gatekeeper.Gate(passphrase="open-sesame-please")
            offline_server.ALLOW_PRIVATE_FETCH = True
            try:
                @check("the gate signs a cookie that it alone accepts")
                def _():
                    cage = gatekeeper.Gate(passphrase="x" * 12)
                    issued = cage.issue()
                    assert cage.accepts(issued), "a freshly issued cookie was rejected"
                    assert not cage.accepts(""), "an empty cookie was accepted"
                    assert not cage.accepts("garbage"), "a malformed cookie was accepted"
                    expires, _, signature = issued.partition(".")
                    assert not cage.accepts(f"{expires}.{'0' * len(signature)}"), "a forged signature was accepted"
                    assert not cage.accepts(f"{int(expires) + 1}.{signature}"), "an altered expiry was accepted"
                    # A different server must not honour this one's cookies.
                    assert not gatekeeper.Gate(passphrase="x" * 12).accepts(issued), "another server accepted it"
                    stale = gatekeeper.Gate(passphrase="x" * 12, days=-1)
                    assert not stale.accepts(stale.issue()), "an expired cookie was accepted"
                    return "forged, altered, foreign and expired cookies all refused"

                @check("the proxy demands the passphrase")
                def _():
                    status, payload, _, _ = raw(browse.PREFIX + browse.encode_target(site_base + "/index.html"))
                    assert status == 401, status
                    assert b"passphrase protected" in payload, payload[:200]
                    return "401 with the login page"

                @check("the archiver's fetcher is behind the same gate")
                def _():
                    status, payload, _, _ = raw("/api/fetch?url=" + quote(site_base + "/index.html", safe=""))
                    assert status == 401, f"an unauthenticated fetch returned {status}"
                    return "401, so it is not an open relay either"

                @check("the app shell stays reachable so it can say it is locked")
                def _():
                    for path in ("/index.html", "/app.js", "/styles.css", "/api/status"):
                        status, _, _, _ = raw(path)
                        assert status == 200, f"{path} returned {status}"
                    return "shell and status open, so a locked server still loads"

                @check("the saved library is behind the gate too")
                def _():
                    status, payload, _, _ = raw("/api/library")
                    assert status == 401, f"anyone reaching the server can read the library ({status})"
                    assert json.loads(payload).get("unlock") == "/p/login", payload[:200]
                    return "401 as JSON, pointing at the login"

                @check("a wrong passphrase is refused")
                def _():
                    status, payload, cookie, _ = raw("/p/login", "POST", "passphrase=nope&next=/p/")
                    assert status == 401, status
                    assert cookie is None, "a cookie was handed out anyway"
                    assert b"not right" in payload, payload[:200]
                    return "401 and no cookie"

                @check("the right passphrase opens it and the cookie works")
                def _():
                    status, _, cookie, location = raw("/p/login", "POST", "passphrase=open-sesame-please&next=/p/")
                    assert status == 303, status
                    assert cookie and gatekeeper.COOKIE_NAME in cookie, cookie
                    assert "HttpOnly" in cookie and "SameSite=Lax" in cookie, f"weak cookie flags: {cookie}"
                    assert location == "/p/", location
                    jar = cookie.split(";")[0]
                    status, payload, _, _ = raw(browse.PREFIX + browse.encode_target(site_base + "/index.html"), cookie=jar)
                    assert status == 200, status
                    assert b"Fixture Site" in payload, payload[:200]
                    # And the archiver's fetcher opens with the same cookie.
                    assert raw("/api/fetch?url=" + quote(site_base + "/index.html", safe=""), cookie=jar)[0] == 200
                    return "303, cookie set, proxy and fetcher both open"

                @check("the login will not bounce somewhere off-site")
                def _():
                    _, _, _, location = raw("/p/login", "POST", "passphrase=open-sesame-please&next=https://example.com/evil")
                    assert location == "/p/", f"an open redirect: {location}"
                    return "off-site next= forced back to /p/"

                @check("--no-proxy-auth serves it open")
                def _():
                    offline_server.GATE = gatekeeper.Gate(enabled=False)
                    try:
                        status, payload, _, _ = raw(browse.PREFIX + browse.encode_target(site_base + "/index.html"))
                        assert status == 200, status
                        assert b"Fixture Site" in payload, payload[:200]
                    finally:
                        offline_server.GATE = gatekeeper.Gate(passphrase="open-sesame-please")
                    return "open when explicitly asked for"

                @check("a generated passphrase is long enough to be worth having")
                def _():
                    generated = gatekeeper.Gate().passphrase
                    assert gatekeeper.Gate().passphrase != generated, "two servers generated the same passphrase"
                    assert len(generated.replace("-", "")) >= 12, f"only {len(generated)} characters"
                    return f"{len(generated)} characters, different every run"

                @check("the login itself enforces the lockout")
                def _():
                    offline_server.GATE = gatekeeper.Gate(passphrase="open-sesame-please")
                    try:
                        # One real wrong answer, to prove the handler counts it at all.
                        raw("/p/login", "POST", "passphrase=nope&next=/p/")
                        assert offline_server.GATE.wrong.get("127.0.0.1"), "a wrong answer was not counted"
                        # The rest are seeded: eight real ones would sleep eight seconds.
                        for _ in range(gatekeeper.WRONG_ALLOWED):
                            offline_server.GATE.record_failure("127.0.0.1")
                        status, payload, cookie, _ = raw("/p/login", "POST", "passphrase=open-sesame-please&next=/p/")
                        assert status == 429, f"the right passphrase still worked while locked out ({status})"
                        assert cookie is None, "a cookie was handed out during a lockout"
                        assert b"Try again in" in payload, payload[:200]
                    finally:
                        offline_server.GATE = gatekeeper.Gate(passphrase="open-sesame-please")
                    return "counts wrong answers, then 429s even the right one"

                @check("repeated wrong passphrases lock the guesser out")
                def _():
                    cage = gatekeeper.Gate(passphrase="x" * 16)
                    for _ in range(gatekeeper.WRONG_ALLOWED):
                        assert cage.locked_out("10.0.0.9") == 0, "locked out before the budget was spent"
                        cage.record_failure("10.0.0.9")
                    assert cage.locked_out("10.0.0.9") > 0, "guessing is unlimited"
                    assert cage.locked_out("10.0.0.10") == 0, "one guesser locked out everybody"
                    cage.forgive("10.0.0.9")
                    assert cage.locked_out("10.0.0.9") == 0, "the right passphrase did not clear it"
                    for _ in range(gatekeeper.WRONG_ALLOWED):
                        cage.record_failure("10.0.0.11")
                    later = time.time() + gatekeeper.LOCKOUT_SECONDS + 1
                    assert cage.locked_out("10.0.0.11", now=later) == 0, "the lockout never lifts"
                    return f"{gatekeeper.WRONG_ALLOWED} guesses, then {gatekeeper.LOCKOUT_SECONDS}s, per address"

                @check("a spray of forged addresses cannot grow the lockout table")
                def _():
                    cage = gatekeeper.Gate(passphrase="x" * 16)
                    for number in range(gatekeeper.MAX_TRACKED + 50):
                        cage.record_failure(f"203.0.113.{number}")
                    assert len(cage.wrong) <= gatekeeper.MAX_TRACKED, f"grew to {len(cage.wrong)}"
                    return f"held at {len(cage.wrong)} entries"

                @check("funnel refuses to publish anything guessable")
                def _():
                    import funnel
                    assert funnel.refuse("a-genuinely-private-phrase", False, ROOT), \
                        "an open proxy was cleared for the public internet"
                    assert funnel.refuse("short-one", True, ROOT), "a short passphrase was cleared"
                    assert funnel.refuse("quietweb-open-up", True, ROOT), "a published example was cleared"
                    allowed = funnel.refuse("vault-hymn-cinder-glass", True, ROOT)
                    assert not allowed, f"a real passphrase was refused: {allowed}"
                    return "open proxy, short and published all refused"

                @check("a passphrase written in the project is not treated as a secret")
                def _():
                    import funnel
                    # A phrase really in the README, so this cannot rot into a no-op.
                    phrase = "an open proxy on a home connection"
                    assert phrase in (ROOT / "README.md").read_text(encoding="utf-8"), "the README moved on"
                    assert funnel.published_in(phrase, ROOT) == "README.md", "did not find it"
                    assert funnel.refuse(phrase, True, ROOT), "a phrase lifted from the README was cleared"
                    return "caught a passphrase copied out of README.md"

                @check("--funnel generates a passphrase strong enough to be public")
                def _():
                    import funnel
                    generated = gatekeeper.Gate(groups=5).passphrase
                    assert len(generated) >= funnel.MIN_PUBLIC_SECRET, f"only {len(generated)} characters"
                    refused = funnel.refuse(generated, True, ROOT)
                    assert not refused, f"its own generated passphrase was refused: {refused}"
                    # And the ordinary one is still too thin for the open internet,
                    # which is the whole reason --funnel asks for more groups.
                    assert funnel.refuse(gatekeeper.Gate().passphrase, True, ROOT), \
                        "the local default cleared the public bar, so --funnel changes nothing"
                    return f"{len(generated)} characters, and the local default is still refused"

                @check("the funnel is started and taken down with the right commands")
                def _():
                    import funnel
                    calls = []

                    def fake(arguments):
                        calls.append(arguments[1:])
                        if "--bg" in arguments:
                            return 0, ("Available on the internet:\n\nhttps://desk.tail1a2b.ts.net/\n"
                                       "|-- proxy http://127.0.0.1:8765\n"), ""
                        return 0, "", ""

                    tunnel = funnel.Funnel(run=fake, binary="tailscale")
                    address = tunnel.start(8765)
                    assert address == "https://desk.tail1a2b.ts.net", address
                    assert calls[0] == ["funnel", "--bg", "8765"], calls[0]
                    assert tunnel.stop() is True, "stopping reported failure"
                    assert calls[1] == ["funnel", "--https=443", "off"], calls[1]
                    assert tunnel.stop() is True and len(calls) == 2, "stopping twice ran the command twice"
                    return "funnel --bg 8765 up, funnel --https=443 off down"

                @check("a funnel that will not start says why")
                def _():
                    import funnel
                    reason = "Funnel is not enabled on your tailnet."

                    def fake(arguments):
                        return 1, "", reason + " Enable it in the admin console."

                    tunnel = funnel.Funnel(run=fake, binary="tailscale")
                    try:
                        tunnel.start(8765)
                    except funnel.FunnelError as error:
                        assert reason in str(error), error
                        assert not tunnel.serving, "a refused funnel is believed to be running"
                        return "relays Tailscale's own reason instead of inventing one"
                    raise AssertionError("a refused funnel was reported as started")

                @check("the public address comes from the daemon when the command prints none")
                def _():
                    import funnel

                    def quiet(arguments):
                        if "status" in arguments:
                            return 0, json.dumps({"Self": {"DNSName": "desk.tail1a2b.ts.net."}}), ""
                        return 0, "Funnel started and running in the background.\n", ""

                    address = funnel.Funnel(run=quiet, binary="tailscale").start(8765)
                    assert address == "https://desk.tail1a2b.ts.net", address

                    def nameless(arguments):
                        if "status" in arguments:
                            return 0, json.dumps({"Self": {"DNSName": ""}}), ""
                        return 0, "", ""

                    try:
                        funnel.Funnel(run=nameless, binary="tailscale").start(8765)
                    except funnel.FunnelError as error:
                        assert "MagicDNS" in str(error), error
                        return "falls back to tailscale status, and refuses to invent a name"
                    raise AssertionError("a machine with no name produced an address anyway")

                @check("a killed server still closes its funnel")
                def _():
                    import signal
                    # Invoke the handler rather than signalling: os.kill would end
                    # this process on Windows, where SIGTERM cannot be caught.
                    previous = signal.getsignal(signal.SIGTERM)
                    try:
                        offline_server.stop_on_termination()
                        handler = signal.getsignal(signal.SIGTERM)
                        assert callable(handler), f"SIGTERM is still {handler}"
                        try:
                            handler(signal.SIGTERM, None)
                        except KeyboardInterrupt:
                            return "SIGTERM unwinds like Ctrl+C, so the funnel comes down"
                        raise AssertionError("SIGTERM would kill the process with the funnel still up")
                    finally:
                        signal.signal(signal.SIGTERM, previous)
            finally:
                offline_server.GATE = None

            @check("restricted-network CIDRs are parsed, and junk is refused")
            def _():
                nets = offline_server.parse_block_networks(["203.0.113.0/24", "10.0.0.0/8, 192.168.1.5"])
                assert len(nets) == 3, [str(n) for n in nets]
                assert str(nets[2]) == "192.168.1.5/32", "a bare address should become a /32"
                assert offline_server.parse_block_networks([""]) == (), "blank should parse to nothing"
                try:
                    offline_server.parse_block_networks(["not-a-network"])
                except SystemExit:
                    return "3 parsed, blank ignored, garbage rejected"
                raise AssertionError("a bad network was accepted")

            @check("the real client is read from X-Forwarded-For, and spoofing only adds")
            def _():
                # Behind a tunnel the socket peer is the tunnel; the client is in XFF.
                seen = offline_server.observed_addresses("10.9.9.9", "203.0.113.5, 70.1.2.3")
                assert str(seen[0]) == "10.9.9.9" and str(seen[1]) == "203.0.113.5", [str(a) for a in seen]
                blocked = (ipaddress.ip_network("203.0.113.0/24"),)
                assert offline_server.restricted_by(seen, blocked), "the forwarded client was not caught"
                # A forged header can only add addresses, so it can disable but never enable.
                honest = offline_server.observed_addresses("203.0.113.5", None)
                assert offline_server.restricted_by(honest, blocked), "the peer itself was not checked"
                assert offline_server.observed_addresses("host.name", " , junk") == [], "junk became an address"
                return "peer and every forwarded hop checked; bad values dropped"

            @check("the proxy declines on a restricted network but the library does not")
            def _():
                import http.client

                def hit(path, xff=None):
                    connection = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=10)
                    connection.request("GET", path, headers={"X-Forwarded-For": xff} if xff else {})
                    response = connection.getresponse()
                    status, body = response.status, response.read()
                    connection.close()
                    return status, body

                offline_server.BLOCK_NETWORKS = offline_server.parse_block_networks(["203.0.113.0/24"])
                try:
                    status, body = hit("/p/", xff="203.0.113.5")
                    assert status == 403, f"proxy served on a restricted network ({status})"
                    assert b"turned off on this network" in body, body[:200]
                    assert hit("/api/fetch?url=http://example.com", xff="203.0.113.5")[0] == 403, "fetch stayed open"
                    assert hit("/api/library", xff="203.0.113.5")[0] == 200, "the library was blocked too"
                    assert hit("/p/")[0] == 200, "an unrestricted visitor was refused"
                    # Blocking loopback proves the socket peer is judged, not only XFF.
                    offline_server.BLOCK_NETWORKS = offline_server.parse_block_networks(["127.0.0.0/8"])
                    assert hit("/p/")[0] == 403, "the peer address was never checked"
                finally:
                    offline_server.BLOCK_NETWORKS = ()
                return "403 with a notice on the restricted net, library and others untouched"

        finally:
            offline_server.ALLOW_PRIVATE_FETCH = origin
            site.shutdown()
            site.server_close()

    finally:
        httpd.shutdown()
        httpd.server_close()

    report()
    failed = [entry for entry in RESULTS if not entry[0]]
    return 1 if failed else 0


def report():
    """Print the results, then repeat any failures so they are the last thing read.

    On a phone the list is taller than the screen, so a count alone means
    scrolling back through dozens of passing lines to find the one that matters.
    """
    width = max(len(name) for _, name, _ in RESULTS)
    columns = shutil.get_terminal_size(fallback=(100, 24)).columns
    roomy = width + 8 < columns

    for passed, name, detail in RESULTS:
        mark = "PASS" if passed else "FAIL"
        if roomy:
            print(f"{mark}  {name.ljust(width)}  {detail}")
        else:
            # Too narrow to align: give each result two clean lines instead of
            # one that wraps mid-word.
            print(f"{mark}  {name}")
            print(f"      {detail}")

    failed = [(name, detail) for passed, name, detail in RESULTS if not passed]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if not failed:
        return
    print(f"\n{len(failed)} failed:")
    for name, detail in failed:
        print(f"\n  {name}")
        print(f"    {detail}")


if __name__ == "__main__":
    raise SystemExit(run())
