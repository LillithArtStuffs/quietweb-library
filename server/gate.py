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
import hashlib
import hmac
import secrets
import time

COOKIE_NAME = "quietweb_gate"
DEFAULT_DAYS = 30


class Gate:
    def __init__(self, passphrase=None, enabled=True, days=DEFAULT_DAYS):
        self.enabled = enabled
        # A generated passphrase is short enough to retype on a phone.
        self.passphrase = passphrase or "-".join(secrets.token_hex(2) for _ in range(3))
        self.generated = passphrase is None
        self.days = days
        # New secret per run, so restarting the server signs everyone out.
        self.secret = secrets.token_bytes(32)

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
