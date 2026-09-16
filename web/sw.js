const CACHE = "quietweb-shell-v6";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/quietweb.svg",
  "./icons/quietweb-192.png",
  "./icons/quietweb-512.png"
];

self.addEventListener("install", (event) => {
  // A single missing file must not sink the whole install, so cache one by one.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(SHELL.map((asset) => cache.add(asset).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

const isCacheable = (response) => response && response.ok && response.type === "basic";

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const shell = await caches.match("./index.html", { ignoreSearch: true });
    return shell || new Response("Quietweb is offline and this file was never cached.", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live server state must never be served from the cache.
  if (url.pathname.startsWith("/api/")) return;

  // The shell changes between builds, so prefer the network and fall back offline.
  const isShell = request.mode === "navigate" || /\.(?:html|js|css|webmanifest)$/.test(url.pathname) || url.pathname === "/";
  event.respondWith(isShell ? networkFirst(request) : cacheFirst(request));
});
