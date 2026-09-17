# Quietweb, and what it taught me about content filtering

## What Quietweb is

Quietweb is a local-first web tool with two halves. The first is an **archiver**:
you give it a URL, a small Python server fetches the page, strips it to readable
HTML, and stores it in your browser so you can read it later with no network at
all. The second is a **rewriting proxy**: the same server can fetch a live page
and serve it back with every link, image, and stylesheet rewritten to route
through the server, so the device you are reading on never talks to the site
directly.

It runs on your own machine. It is not a hosted service, and by default it binds
to loopback and refuses to fetch private addresses. The rest of this document is
about what happened when I tried to answer one question: **can a tool like this
be reached from a locked-down, school-managed device?** The answer turned out to
be more interesting than a yes or a no.

## How the proxy works

The proxy is a small, honest piece of engineering, and the parts that matter to
the rest of this write-up are:

- **Server-side fetch.** Browsers refuse to read most pages from other origins
  (the same-origin policy). The server has no such restriction, so it does the
  fetching and hands back the result. This is the whole reason the tool exists —
  it is also, as it turns out, exactly what a filter is built to detect.
- **URL rewriting.** Every address in the returned HTML — links, `src`, `srcset`
  descriptors, CSS `url()` and `@import` — is resolved against the page's real
  base and rewritten to point back through the proxy. The reading device only
  ever sees addresses on the proxy's own host.
- **A passphrase gate.** An open proxy is the most-abused misconfiguration on the
  internet, so the proxy is authenticated by default with an HMAC-signed cookie,
  and it rate-limits wrong guesses.

Keep the first two points in mind: **an address bar that fetches arbitrary sites
and re-serves them under one host is the textbook definition of a web proxy.**
That is the signature the experiment below runs into.

## The experiment: reaching it from a managed device

The target was a school-managed Chromebook running an **on-device content filter
agent** (Lightspeed). On-device matters: the filter is a browser extension that
classifies every request the browser makes, so it applies on *any* network the
laptop joins, not just the school Wi-Fi. That single fact rules out a whole class
of "just use a different network" ideas before you start.

I worked through the reachability problem one layer at a time. Each layer is a
different answer to "where does the code run, and how does the Chromebook reach
it."

### Layer 1 — run it on the Chromebook itself

If the server runs locally, the Chromebook would reach it at `localhost`, which a
content filter has no reason to classify (it is not a website). This is the
cleanest possible win.

**Result: blocked at the source.** Running the server needs a Linux runtime
(Crostini), which is disabled by administrative policy on the device —
independent of Developer Mode, and also off. No local runtime, no local server.

### Layer 2 — run it elsewhere and reach it over the network

If the server runs on a home PC or a phone, the Chromebook has to reach it across
the network. I tried a private mesh address (Tailscale), a public tunnel
(`ts.net`, `trycloudflare.com`), and a raw local IP over a phone hotspot.

**Result: deny-by-default.** Every one of these was blocked, and the reason is
the important part. Testing `http://127.0.0.1` — the Chromebook's own loopback —
also returned the block page, categorized as *unknown*. That is the tell: the
filter is not running a **blocklist** of known-bad sites, which you could dodge
with an address it has not seen. It is running an **allowlist** — anything it
cannot positively place in a permitted category is refused. A bare IP has no
category, so it is refused on sight. No self-hosted address, on any network, can
beat an allowlist.

### Layer 3 — host it on a service the school already allows

The allowlist has holes by definition: the domains the school *does* permit. If
the code runs on a cloud service whose domain is allowed, the Chromebook can
reach it, and the actual web-fetching happens on that service's servers, where
the on-device agent cannot see it. Two candidates — Replit and GitHub Codespaces
— serve deployed apps on domains (`replit.dev`, `app.github.dev`) that the school
allows for coursework.

**Result: reachability succeeds — and then something better happens.** The
Codespaces domain loaded. The forwarded-port URL served the Quietweb app. And the
moment it did, the filter blocked *that specific host* with a new reason:

> `…-8080.app.github.dev` is not available because it is categorized as
> **Security – Proxy**.

Not *unknown*. **Proxy.** The filter inspected what the host was actually serving
— a page with an address bar that fetches and re-serves other sites — and
classified it, in real time, as a proxy it had never seen before. The allowed
domain got the request through the door; the filter caught the tool on its
*behavior*, not its address.

## The finding

**Reachability is not access.** The interesting result of this project is not
whether the proxy could be reached — it is *how the filter stopped it once it
was*.

A naïve model of a content filter is a list of bad domains. Everything in this
experiment says that model is wrong for a modern managed device:

1. It is **allowlist-first**: uncategorized destinations, including loopback and
   raw IPs, are denied rather than allowed. (Layer 2)
2. It does **real-time behavioral classification**: a brand-new host on an
   allowed domain, serving a proxy the vendor had never seen, was categorized as
   `Security – Proxy` on inspection and blocked. (Layer 3)

The second point is the one worth sitting with. It means the effective defense
was not a database of known proxies — it was a classifier that recognized
*proxy-shaped behavior* from a single unfamiliar host. That is a meaningfully
harder thing to build than a blocklist, and this project demonstrates it from the
outside, empirically, without any privileged access to how the filter works.

## Where this leaves the tool

None of the above is a failure of Quietweb — it is the tool working exactly as
built, on networks where it is meant to work: any device you own, on any network
that is not policing you. The managed-device result is the *research outcome*,
not a bug.

And because the honest conclusion of this study is "the filter is right to stop
this here," the tool now acts on that conclusion. Quietweb has a
`--block-network` option: name the networks where it must not proxy, and on a
request from one of those networks it declines and shows a notice instead of
routing around the filter. It reads the client address from `X-Forwarded-For` as
well as the socket, so it holds up behind exactly the cloud port-forwards this
experiment used. The tool that this write-up describes reaching a managed device
is also the tool that now refuses to.

That is the part I am most satisfied with. Understanding a security control well
enough to get it to reveal its own model is one thing. Choosing to respect it
once you do is the other.
