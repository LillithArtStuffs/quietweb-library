"""Passphrase gate for the browsing proxy.

An open proxy on a home connection is the most abused misconfiguration there
is: anyone who finds it can route traffic through it, and that traffic looks
like it came from the person hosting it. So the proxy is authenticated by
default. A passphrase is generated at startup if one is not supplied, exactly
as the admin token already is.

The cookie is an expiry and an HMAC of that expiry, so it can be checked with
no server-side session store and stops being valid on its own.
"""

from http.cookies import SimpleCookie
from threading import Lock
import hashlib
import hmac
import secrets
import time

COOKIE_NAME = "quietweb_gate"
DEFAULT_DAYS = 30
# Guessing budget. The server is threaded, so a one second pause per wrong
# answer is no obstacle to someone trying hundreds at once; a lockout is.
WRONG_ALLOWED = 8
LOCKOUT_SECONDS = 60
MAX_TRACKED = 1024


class Gate:
    def __init__(self, passphrase=None, enabled=True, days=DEFAULT_DAYS, groups=3):
        self.enabled = enabled
        # A generated passphrase is short enough to retype on a phone. More
        # groups when it is going somewhere public, where 48 bits is thin.
        self.passphrase = passphrase or "-".join(secrets.token_hex(2) for _ in range(groups))
        self.generated = passphrase is None
        self.days = days
        # New secret per run, so restarting the server signs everyone out.
        self.secret = secrets.token_bytes(32)
        self.wrong = {}
        self.wrong_lock = Lock()

    def _sign(self, expires):
        return hmac.new(self.secret, str(expires).encode("ascii"), hashlib.sha256).hexdigest()

    def issue(self):
        expires = int(time.time()) + self.days * 86400
        return f"{expires}.{self._sign(expires)}"

    def accepts(self, value):
        if not value or "." not in value:
            return False
        expires, _, signature = value.partition(".")
        if not expires.isdigit():
            return False
        if not hmac.compare_digest(signature, self._sign(expires)):
            return False
        return int(expires) > time.time()

    def matches(self, attempt):
        return hmac.compare_digest(str(attempt or ""), self.passphrase)

    def locked_out(self, client, now=None):
        """Seconds this client must wait before guessing again, or 0.

        Behind a funnel every request arrives from the local Tailscale daemon,
        so this collapses into one shared budget. That is the safe direction:
        it throttles the internet as a whole rather than letting each source
        address have its own allowance.
        """
        now = time.time() if now is None else now
        with self.wrong_lock:
            recent = [at for at in self.wrong.get(client, []) if at > now - LOCKOUT_SECONDS]
            if recent:
                self.wrong[client] = recent
            else:
                self.wrong.pop(client, None)
            if len(recent) < WRONG_ALLOWED:
                return 0
            return max(1, int(recent[0] + LOCKOUT_SECONDS - now))

    def record_failure(self, client, now=None):
        """Count a wrong passphrase against this client."""
        now = time.time() if now is None else now
        with self.wrong_lock:
            if client not in self.wrong and len(self.wrong) >= MAX_TRACKED:
                # Never let a spray of forged source addresses grow this without
                # bound; the oldest entry is the one worth losing.
                self.wrong.pop(next(iter(self.wrong)), None)
            self.wrong.setdefault(client, []).append(now)

    def forgive(self, client):
        """Clear a client's failures once it gets the passphrase right."""
        with self.wrong_lock:
            self.wrong.pop(client, None)

    def cookie_header(self, value):
        age = self.days * 86400
        return f"{COOKIE_NAME}={value}; Path=/; Max-Age={age}; HttpOnly; SameSite=Lax"

    def permits(self, raw_cookie_header):
        """True when this request may use the proxy."""
        if not self.enabled:
            return True
        if not raw_cookie_header:
            return False
        jar = SimpleCookie()
        try:
            jar.load(raw_cookie_header)
        except Exception:
            return False
        present = jar.get(COOKIE_NAME)
        return bool(present) and self.accepts(present.value)


def login_page(next_path="/p/", message=""):
    note = f'<p class="note">{message}</p>' if message else ""
    return (
        '<!doctype html><meta charset="utf-8"><title>Quietweb</title>'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        "<style>body{margin:0;display:grid;place-items:center;min-height:100vh;"
        "background:#13100f;color:#e3e3e3;font:15px/1.6 system-ui,sans-serif}"
        "form{width:min(360px,calc(100% - 40px));padding:28px;border:1px solid #2e282b;"
        "border-radius:6px;background:#171416}h1{margin:0 0 6px;font-size:19px}"
        "p{margin:0 0 18px;color:#8d8288;font-size:13px}.note{color:#e0566f}"
        "input{width:100%;box-sizing:border-box;padding:10px;margin-bottom:12px;"
        "border:1px solid #3a3237;border-radius:4px;background:#0d0b0c;color:#e3e3e3;"
        "font:14px system-ui,sans-serif}button{width:100%;padding:10px;border:0;"
        "border-radius:4px;background:#b8344c;color:#fff;font:700 13px system-ui,sans-serif}"
        "</style>"
        f'<form method="post" action="/p/login"><h1>Quietweb</h1>'
        f"<p>This proxy is passphrase protected.</p>{note}"
        f'<input type="hidden" name="next" value="{next_path}">'
        '<input name="passphrase" type="password" autocomplete="current-password" '
        'autofocus placeholder="Passphrase">'
        "<button>Unlock</button></form>"
    )
