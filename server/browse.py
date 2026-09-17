"""URL rewriting for the live browsing proxy.

Every address in a proxied page is resolved against the page's real URL and
then pointed back at this server, so following a link stays inside the proxy
instead of escaping to the open internet. Pages are served from /p/<token>,
where the token is the target URL in URL-safe base64.

This is a rewriting proxy, which has a hard limit worth stating plainly: it can
only rewrite addresses that are present in the markup. Sites that build their
URLs in JavaScript at runtime will not work, and no amount of rewriting fixes
that.
"""

from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit
import base64
import re

PREFIX = "/p/"

# Attributes that carry a single URL.
URL_ATTRIBUTES = {"src", "href", "action", "poster", "formaction", "background", "data-src", "longdesc"}
# Attributes naming a resource the browser must verify or re-fetch itself, and
# which can only fail once the bytes are coming from somewhere else.
DROPPED_ATTRIBUTES = {"integrity", "crossorigin", "nonce", "ping"}
# Void elements, so the rewritten markup stays well formed.
VOID_ELEMENTS = {"area", "base", "br", "col", "embed", "hr", "img", "input",
                 "link", "meta", "param", "source", "track", "wbr"}

CSS_URL = re.compile(r"""url\(\s*(['"]?)(?!data:|about:|#)([^'")]+)\1\s*\)""", re.I)
CSS_IMPORT = re.compile(r"""@import\s+(['"])(?!data:)([^'"]+)\1""", re.I)


def encode_target(url):
    """Turn an absolute URL into the token used in a /p/ path."""
    return base64.urlsafe_b64encode(url.encode("utf-8")).decode("ascii").rstrip("=")


def decode_target(token):
    padded = token + "=" * (-len(token) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")


def proxied(url, base):
    """Resolve a possibly relative URL against base and point it at the proxy."""
    if not url:
        return url
    stripped = url.strip()
    lowered = stripped.lower()
    # Addresses the proxy has no business touching.
    if lowered.startswith(("data:", "about:", "javascript:", "mailto:", "tel:", "blob:", "#")):
        return stripped
    absolute = urljoin(base, stripped)
    if urlsplit(absolute).scheme not in {"http", "https"}:
        return stripped
    return PREFIX + encode_target(absolute)


def rewrite_css(text, base):
    """Point url() and @import at the proxy so stylesheets and fonts still load."""
    text = CSS_URL.sub(lambda m: f'url({m.group(1)}{proxied(m.group(2), base)}{m.group(1)})', text)
    return CSS_IMPORT.sub(lambda m: f'@import {m.group(1)}{proxied(m.group(2), base)}{m.group(1)}', text)


def rewrite_srcset(value, base):
    """srcset is a comma separated list of "url descriptor" pairs."""
    parts = []
    for candidate in value.split(","):
        candidate = candidate.strip()
        if not candidate:
            continue
        pieces = candidate.split(None, 1)
        target = proxied(pieces[0], base)
        parts.append(target if len(pieces) == 1 else f"{target} {pieces[1]}")
    return ", ".join(parts)


def escape_attribute(value):
    return (str(value).replace("&", "&amp;").replace('"', "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;"))


class Rewriter(HTMLParser):
    """Rebuilds a document with every address routed back through the proxy."""

    def __init__(self, base, keep_scripts=True):
        super().__init__(convert_charrefs=False)
        self.base = base
        self.keep_scripts = keep_scripts
        self.output = []
        self.skip_depth = 0
        self.in_style = False

    # A <base href> changes what every relative URL on the page means.
    def _absorb_base(self, attrs):
        for name, value in attrs:
            if name.lower() == "href" and value:
                self.base = urljoin(self.base, value.strip())

    def _open(self, tag, attrs, self_closing):
        pieces = []
        for name, value in attrs:
            lowered = name.lower()
            if lowered in DROPPED_ATTRIBUTES:
                continue
            if value is None:
                pieces.append(f" {lowered}")
                continue
            if lowered == "srcset" or lowered == "imagesrcset":
                value = rewrite_srcset(value, self.base)
            elif lowered in URL_ATTRIBUTES:
                value = proxied(value, self.base)
            elif lowered == "style":
                value = rewrite_css(value, self.base)
            pieces.append(f' {lowered}="{escape_attribute(value)}"')
        closer = " /" if self_closing and tag not in VOID_ELEMENTS else ""
        self.output.append(f"<{tag}{''.join(pieces)}{closer}>")

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag == "base":
            self._absorb_base(attrs)
            return  # Dropped: the rewritten URLs are already absolute.
        if tag == "script" and not self.keep_scripts:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag == "style":
            self.in_style = True
        self._open(tag, attrs, False)

    def handle_startendtag(self, tag, attrs):
        tag = tag.lower()
        if tag == "base":
            self._absorb_base(attrs)
            return
        if (tag == "script" and not self.keep_scripts) or self.skip_depth:
            return
        self._open(tag, attrs, True)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag == "script" and not self.keep_scripts:
            self.skip_depth = max(0, self.skip_depth - 1)
            return
        if self.skip_depth:
            return
        if tag == "style":
            self.in_style = False
        if tag not in VOID_ELEMENTS:
            self.output.append(f"</{tag}>")

    def handle_data(self, data):
        if self.skip_depth:
            return
        self.output.append(rewrite_css(data, self.base) if self.in_style else data)

    def handle_entityref(self, name):
        if not self.skip_depth:
            self.output.append(f"&{name};")

    def handle_charref(self, name):
        if not self.skip_depth:
            self.output.append(f"&#{name};")

    def handle_comment(self, data):
        return  # Conditional comments can hide markup; drop them all.

    def handle_decl(self, decl):
        if not self.skip_depth:
            self.output.append(f"<!{decl}>")


def toolbar(current_url):
    """A slim address bar, so the proxy is usable without going back to the app."""
    return (
        '<div id="quietweb-bar" style="position:sticky;top:0;z-index:2147483647;display:flex;'
        'gap:8px;align-items:center;padding:8px 10px;background:#13100f;color:#e3e3e3;'
        'font:13px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35)">'
        '<form action="/p/go" method="get" style="display:flex;gap:8px;flex:1;margin:0">'
        '<input name="url" value="' + escape_attribute(current_url) + '" spellcheck="false" '
        'autocapitalize="off" style="flex:1;min-width:0;padding:7px 9px;border:1px solid #3a3237;'
        'border-radius:4px;background:#0d0b0c;color:#e3e3e3;font:13px system-ui,sans-serif">'
        '<button style="padding:7px 12px;border:0;border-radius:4px;background:#b8344c;color:#fff;'
        'font:700 12px system-ui,sans-serif">Go</button></form>'
        '<a href="/" style="color:#bcb6ba;text-decoration:none;white-space:nowrap">Library</a></div>'
    )


def notice_page(message):
    """Shown in place of the proxy when it will not operate on this network."""
    return (
        '<!doctype html><meta charset="utf-8"><title>Browse unavailable</title>'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        "<style>body{margin:0;background:#13100f;color:#e3e3e3;"
        "font:15px/1.6 system-ui,sans-serif}main{padding:48px 24px;max-width:620px}"
        "h1{font-size:22px;font-weight:600;margin:0 0 10px}p{color:#bcb6ba;margin:0 0 10px}"
        "a{color:#e0566f}</style>"
        "<main><h1>Browsing is turned off on this network</h1>"
        f"<p>{escape_attribute(message)}</p>"
        "<p>Your saved library still works — this only affects live browsing "
        "through the proxy.</p>"
        '<p><a href="/">Back to the library</a></p></main>'
    )


def rewrite_html(html, base, keep_scripts=True, with_toolbar=True):
    rewriter = Rewriter(base, keep_scripts=keep_scripts)
    rewriter.feed(html)
    rewriter.close()
    body = "".join(rewriter.output)
    if not with_toolbar:
        return body
    # Inject after <body ...> when there is one, otherwise lead with it.
    match = re.search(r"<body\b[^>]*>", body, re.I)
    if match:
        return body[:match.end()] + toolbar(base) + body[match.end():]
    return toolbar(base) + body
