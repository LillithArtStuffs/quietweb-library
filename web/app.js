const DB_NAME = "quietweb-library";
const DB_VERSION = 1;
const STORE = "pages";
const state = { pages: [], activeFilter: "all", selectedId: null, deferredInstall: null, storageReady: false };
let lastAnnouncement = "";
let lastServerState = "unknown";
let lastSharedSignature = "";
const $ = (id) => document.getElementById(id);

const db = new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function store(mode, action) {
  const database = await db;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const getAll = () => store("readonly", (items) => items.getAll());
const put = (page) => store("readwrite", (items) => items.put(page));
const remove = (id) => store("readwrite", (items) => items.delete(id));

async function init() {
  applyTheme(localStorage.getItem("quietweb-theme") || "dark");
  state.pages = await getAll();
  state.storageReady = true;
  if (!state.pages.length) {
    state.pages = [
      makePage("Welcome to quietweb", "start here", "This is your local reading room. Save a web snapshot, bookmark a source, or write a note.\n\nThe browser stores your collection on this device, and the app shell can be installed for offline use.", "note"),
      makePage("A small offline kit", "field notes", "Keep only what you return to: maps, guides, recipes, references, and project notes. A useful archive is selective and easy to search.", "note")
    ];
    await Promise.all(state.pages.map(put));
  }
  bindEvents();
  logEvent(`ready · ${state.pages.length} pages loaded · theme ${document.documentElement.dataset.theme}`);
  await syncFromServer();
  renderList();
  registerPWA();
}

function makePage(title, tag, content, type = "note", url = "", html = "") {
  return { id: "page-" + crypto.randomUUID(), title, tag: tag || "untagged", content, type, url, html, created: new Date().toISOString(), size: content.length + html.length };
}

function showView(name) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === name + "View"));
  if (name === "library") renderList();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderTest(name, passed, detail, duration) {
  return `<article class="test-result ${passed ? "pass" : "fail"}"><span class="test-icon">${passed ? "✓" : "!"}</span><div><strong>${escapeHtml(name)}</strong><p>${escapeHtml(detail)}</p></div><span class="test-time">${duration} ms</span></article>`;
}

async function runDiagnostics() {
  const tests = [];
  const check = async (name, action) => {
    const started = performance.now();
    try { const detail = await action(); tests.push({ name, passed: true, detail, duration: Math.round(performance.now() - started) }); }
    catch (error) { tests.push({ name, passed: false, detail: error.message || "Check failed", duration: Math.round(performance.now() - started) }); }
  };
  await check("IndexedDB archive", async () => { const probe = makePage("__diagnostic__", "test", "ok"); await put(probe); const found = (await store("readonly", (items) => items.get(probe.id)))?.title === "__diagnostic__"; await remove(probe.id); if (!found) throw new Error("The browser could not write and read a test record."); return "Local page storage is working."; });
  await check("Service worker support", async () => { if (!("serviceWorker" in navigator)) throw new Error("This browser does not support service workers."); return "Offline app-shell support is available."; });
  await check("Installable app manifest", async () => { const response = await fetch("manifest.webmanifest", { cache: "no-store" }); if (!response.ok) throw new Error("Manifest returned HTTP " + response.status + "."); const manifest = await response.json(); if (!manifest.name || !manifest.start_url) throw new Error("Manifest is missing required fields."); return "The install manifest is reachable."; });
  await check("File import capability", async () => { if (!("FileReader" in window) || !("DOMParser" in window)) throw new Error("File import APIs are unavailable."); return "HTML, text, and library imports are supported."; });
  await check("Secure app context", async () => { if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") throw new Error("Use localhost or HTTPS for full offline/PWA support."); return "The app is running in a browser context that supports its features."; });
  $("testResults").innerHTML = tests.map((test) => renderTest(test.name, test.passed, test.detail, test.duration)).join("");
  const passed = tests.filter((test) => test.passed).length;
  $("diagnosticSummary").textContent = `${passed} of ${tests.length} checks passed`;
}

function visiblePages() {
  const query = $("searchInput").value.trim().toLowerCase();
  const sort = $("sortSelect").value;
  return state.pages.filter((page) => {
    const searchable = `${page.title} ${page.tag} ${page.content} ${page.url}`.toLowerCase();
    const matchesSearch = !query || searchable.includes(query);
    const matchesFilter = state.activeFilter === "all" || (state.activeFilter === "snapshot" ? Boolean(page.html) : page.type === state.activeFilter);
    return matchesSearch && matchesFilter;
  }).sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title);
    if (sort === "oldest") return a.created.localeCompare(b.created);
    if (sort === "size") return b.size - a.size;
    return b.created.localeCompare(a.created);
  });
}

function renderList() {
  const pages = visiblePages();
  $("resultCount").textContent = `${pages.length} of ${state.pages.length}`;
  $("filterCount").textContent = state.activeFilter === "all" ? "" : "1";
  $("pageList").innerHTML = pages.length ? pages.map((page) => `
    <article class="page-row" data-id="${escapeHtml(page.id)}" tabindex="0" role="button">
      <div><span class="page-row-tag">${escapeHtml(page.tag)}</span><span class="row-type">${typeLabel(page)}</span></div>
      <div><h3>${escapeHtml(page.title)}</h3><p>${escapeHtml(preview(page.content))}</p></div>
      <time class="page-row-date">${formatDate(page.created)}</time>
    </article>`).join("") : `<div class="empty-state"><strong>No pages here yet.</strong><span>Try another search or add something to the library.</span></div>`;
  document.querySelectorAll(".page-row").forEach((row) => {
    row.addEventListener("click", () => openReader(row.dataset.id));
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") openReader(row.dataset.id); });
  });
}

function typeLabel(page) {
  if (page.html) return "offline snapshot";
  return { bookmark: "bookmark", code: "source code", note: "note", snapshot: "snapshot" }[page.type] || "saved page";
}

function preview(content) { return content.length > 145 ? content.slice(0, 145).replace(/\s+\S*$/, "") + "..." : content; }
function formatDate(value) { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character])); }

function openReader(id) {
  const page = state.pages.find((item) => item.id === id);
  if (!page) return;
  state.selectedId = id;
  $("readerTag").textContent = page.tag;
  $("readerTitle").textContent = page.title;
  $("readerMeta").textContent = `${typeLabel(page)} · saved ${formatDate(page.created)}`;
  const body = $("readerBody");
  body.className = "reader-body";
  body.innerHTML = "";
  if (page.html) {
    const frame = document.createElement("iframe");
    frame.title = "Offline page snapshot";
    frame.sandbox = "";
    frame.srcdoc = page.html;
    body.append(frame);
  } else {
    body.textContent = page.content || "This bookmark has no archived content yet.";
    if (page.type === "code") body.classList.add("code");
  }
  if (page.url) {
    const source = document.createElement("a");
    source.className = "reader-source";
    source.href = page.url;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    source.textContent = `Source: ${page.url}`;
    body.append(source);
  }
  $("readerActions").innerHTML = `<button class="button subtle" data-reader-action="fetch" ${page.url ? "" : "disabled"}>Refresh snapshot</button><button class="button subtle" data-reader-action="delete">Delete</button>`;
  $("readerActions").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => handleReaderAction(button.dataset.readerAction, page)));
  showView("reader");
}

async function saveEntry() {
  const title = $("titleInput").value.trim();
  const tag = $("tagInput").value.trim() || "untagged";
  const url = normalizeUrl($("urlInput").value.trim());
  const content = $("contentInput").value.trim();
  const type = $("typeInput").value;
  if (!title || (!content && !url)) throw new Error("Add a title and either content or a URL.");
  const page = makePage(title, tag, content || "Bookmark saved. Archive the source when you are online.", type, url);
  if (window.__pendingSnapshot) {
    page.html = window.__pendingSnapshot;
    page.type = "snapshot";
    page.size = page.content.length + page.html.length;
  }
  await put(page);
  state.pages.unshift(page);
  await syncToServer();
  logEvent(`saved · ${title}`);
  clearForm();
  showToast("Saved to your local library.");
  showView("library");
}

async function fetchIntoForm() {
  const url = normalizeUrl($("urlInput").value.trim());
  if (!url) throw new Error("Add a complete http:// or https:// URL first.");
  setStatus("Fetching and preparing a local snapshot...");
  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) throw new Error(`The source returned ${response.status}.`);
  const html = await response.text();
  const snapshot = sanitizeHtml(html);
  const documentCopy = new DOMParser().parseFromString(snapshot, "text/html");
  const readable = textFromDocument(documentCopy);
  if (!readable) throw new Error("The source did not contain readable text.");
  if (!$("titleInput").value.trim()) $("titleInput").value = documentCopy.title || url;
  $("contentInput").value = readable;
  $("typeInput").value = "snapshot";
  setStatus("Ready. Save to keep this snapshot on the device.");
  window.__pendingSnapshot = snapshot;
  logEvent(`fetched · ${url}`);
}

async function refreshSnapshot(page) {
  if (!page.url) return;
  showToast("Fetching a fresh snapshot...");
  const response = await fetch(page.url, { mode: "cors" });
  if (!response.ok) throw new Error("The source could not be fetched.");
  page.html = sanitizeHtml(await response.text());
  page.content = textFromDocument(new DOMParser().parseFromString(page.html, "text/html"));
  page.size = page.content.length + page.html.length;
  await put(page);
  await syncToServer();
  openReader(page.id);
  showToast("Snapshot refreshed.");
  logEvent(`snapshot refreshed · ${page.title}`);
}

function sanitizeHtml(rawHtml) {
  const documentCopy = new DOMParser().parseFromString(rawHtml, "text/html");
  documentCopy.querySelectorAll("script, noscript, iframe, object, embed, form, input, button, link[rel=\"import\"]").forEach((element) => element.remove());
  documentCopy.querySelectorAll("[onload], [onclick], [onerror], [srcdoc]").forEach((element) => { element.removeAttribute("onload"); element.removeAttribute("onclick"); element.removeAttribute("onerror"); element.removeAttribute("srcdoc"); });
  documentCopy.querySelectorAll("a").forEach((link) => { link.target = "_blank"; link.rel = "noopener noreferrer"; });
  const styles = [...documentCopy.querySelectorAll("style")].map((style) => style.outerHTML).join("\n");
  const body = documentCopy.body ? documentCopy.body.innerHTML : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:24px;font-family:system-ui,Arial,sans-serif;line-height:1.6;color:#202426}img{max-width:100%;height:auto}pre{overflow:auto;padding:12px;background:#eee}</style>${styles}</head><body>${body}</body></html>`;
}

function textFromDocument(documentCopy) { documentCopy.querySelectorAll("script,style,noscript,nav,footer,header").forEach((element) => element.remove()); return (documentCopy.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim(); }
function normalizeUrl(value) { if (!value) return ""; const url = new URL(value); if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http:// and https:// links are supported."); return url.href; }
function clearForm() { ["titleInput", "tagInput", "urlInput", "contentInput"].forEach((id) => $(id).value = ""); $("typeInput").value = "snapshot"; $("entryStatus").textContent = ""; window.__pendingSnapshot = ""; }
function setStatus(message) { $("entryStatus").textContent = message; }
function showToast(message) { const toast = $("toast"); toast.textContent = message; toast.classList.add("show"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove("show"), 3000); }
function applyTheme(theme) { const selected = ["dark", "light", "teto"].includes(theme) ? theme : "dark"; document.documentElement.dataset.theme = selected; if ($("themeSelect")) $("themeSelect").value = selected; localStorage.setItem("quietweb-theme", selected); }
function logEvent(message) { const output = $("consoleOutput"); if (!output) return; const timestamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); output.textContent += `\n[${timestamp}] ${message}`; output.scrollTop = output.scrollHeight; }

function sharedSignature(pages) { return JSON.stringify(pages.map((page) => `${page.id}:${page.created}:${page.size}`).sort()); }

async function syncFromServer() {
  try {
    const response = await fetch("/api/library", { cache: "no-store" });
    if (!response.ok) throw new Error("Shared library unavailable");
    const remote = await response.json();
    if (remote.pages.length) {
      const signature = sharedSignature(remote.pages);
      if (signature !== lastSharedSignature) {
        state.pages = remote.pages;
        await Promise.all(state.pages.map(put));
        lastSharedSignature = signature;
        renderList();
        logEvent(`shared library loaded · ${state.pages.length} pages`);
      }
    } else if (state.pages.length && localStorage.getItem("quietweb-admin-token")) {
      await syncToServer();
    }
  } catch (error) {
    logEvent("shared library unavailable · using local copy");
  }
}

async function syncToServer() {
  const token = localStorage.getItem("quietweb-admin-token");
  if (!token) return;
  const response = await fetch("/api/library", { method: "POST", headers: { "Content-Type": "application/json", "X-Quietweb-Admin": token }, body: JSON.stringify({ pages: state.pages }) });
  if (!response.ok) throw new Error("Shared library write rejected. Check the admin token.");
  lastSharedSignature = sharedSignature(state.pages);
  logEvent(`shared library saved · ${state.pages.length} pages`);
}

function formatUptime(seconds) { const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60); const secs = seconds % 60; return `${days ? days + "d " : ""}${hours}h ${minutes}m ${secs}s`; }

async function refreshServerStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("offline");
    const status = await response.json();
    const nextServerState = state.storageReady ? "ready" : "storage-issue";
    const connection = $("connectionState");
    connection.className = state.storageReady ? "connection online" : "connection degraded";
    connection.innerHTML = `<i></i> ${state.storageReady ? "All systems ready" : "Storage issue"} · ${formatUptime(status.uptime || 0)}`;
    $("connectionState").title = `${status.runtime || "Server"} at ${location.hostname}:${status.port || location.port}`;
    $("serverBadge").textContent = "Server connected";
    $("serverBadge").classList.add("online");
    $("serverUptime").textContent = formatUptime(status.uptime || 0);
    $("serverRuntime").textContent = status.runtime || "unknown";
    $("serverAddress").textContent = `${location.hostname}:${status.port || location.port}`;
    $("serverNotice").hidden = true;
    if (status.announcement?.message && status.announcement.message !== lastAnnouncement) {
      lastAnnouncement = status.announcement.message;
      $("announcementBanner").textContent = status.announcement.message;
      $("announcementBanner").hidden = false;
      if (lastAnnouncement) showToast("New server announcement");
    }
    if (nextServerState !== lastServerState) logEvent(`server online · ${state.storageReady ? "all systems ready" : "storage issue"}`);
    lastServerState = nextServerState;
  } catch (error) {
    const connection = $("connectionState");
    connection.className = state.storageReady ? "connection degraded" : "connection offline";
    connection.innerHTML = `<i></i> ${state.storageReady ? "Browser-only mode" : "Storage unavailable"}`;
    $("connectionState").title = "No local Quietweb server detected. Imported and saved content still works.";
    $("serverBadge").textContent = "Browser-only mode";
    $("serverBadge").classList.remove("online");
    $("serverUptime").textContent = "--";
    $("serverRuntime").textContent = "--";
    $("serverAddress").textContent = "static app";
    $("serverNotice").hidden = false;
    const nextServerState = state.storageReady ? "browser-only" : "offline";
    if (nextServerState !== lastServerState) logEvent(state.storageReady ? "server unavailable · local storage ready" : "server and storage unavailable");
    lastServerState = nextServerState;
  }
}

async function sendAnnouncement(message) {
  const token = $("adminToken").value.trim();
  if (!token) throw new Error("Enter the admin token printed by the server.");
  const response = await fetch("/api/admin/announcement", { method: "POST", headers: { "Content-Type": "application/json", "X-Quietweb-Admin": token }, body: JSON.stringify({ message }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The server rejected the announcement.");
  localStorage.setItem("quietweb-admin-token", token);
  lastAnnouncement = result.message;
  $("announcementBanner").textContent = result.message;
  $("announcementBanner").hidden = !result.message;
  $("adminStatus").textContent = result.message ? "Broadcast sent to connected viewers." : "Announcement cleared.";
}

function writeConsole(line) {
  const output = $("consoleOutput");
  output.textContent += `\n${line}`;
  output.scrollTop = output.scrollHeight;
}

async function runConsoleCommand(command) {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return;
  writeConsole(`> ${command}`);
  if (normalized === "help") {
    writeConsole("commands: help, status, tests, clear, theme");
  } else if (normalized === "status") {
    writeConsole(`pages: ${state.pages.length} | storage: IndexedDB | origin: ${location.origin}`);
    try { const response = await fetch("/api/status"); writeConsole(response.ok ? "server: connected" : "server: unavailable"); } catch (error) { writeConsole("server: static/browser-only mode"); }
  } else if (normalized === "tests") {
    await runDiagnostics();
    writeConsole($("diagnosticSummary").textContent);
  } else if (normalized === "clear") {
    $("consoleOutput").textContent = "Console cleared.";
  } else if (normalized === "theme") {
    writeConsole(`theme: ${document.documentElement.dataset.theme} · use the header selector to change it`);
  } else {
    writeConsole("Unknown command. Type help for the safe command list.");
  }
}

async function handleReaderAction(action, page) { try { if (action === "delete") { await remove(page.id); state.pages = state.pages.filter((item) => item.id !== page.id); await syncToServer(); showToast("Page deleted."); showView("library"); } else { await refreshSnapshot(page); } } catch (error) { showToast(error.message); } }

function importFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      if (/\.json$/i.test(file.name)) {
        const incoming = JSON.parse(reader.result);
        const pages = Array.isArray(incoming) ? incoming : incoming.pages;
        if (!Array.isArray(pages)) throw new Error("Not a library export.");
        await Promise.all(pages.filter((page) => page.title && page.content).map((page) => put({ ...page, id: page.id || "page-" + crypto.randomUUID() })));
        state.pages = await getAll();
        renderList(); await syncToServer(); showToast("Library imported."); logEvent(`library imported · ${pages.length} pages`); return;
      }
      const raw = String(reader.result);
      const isHtml = /\.html?$/i.test(file.name) || /<html[\s>]/i.test(raw);
      const html = isHtml ? sanitizeHtml(raw) : "";
      const content = isHtml ? textFromDocument(new DOMParser().parseFromString(html, "text/html")) : raw.trim();
      const page = makePage(file.name.replace(/\.[^.]+$/, ""), "imported", content, isHtml ? "snapshot" : "note", "", html);
      await put(page); state.pages.unshift(page); await syncToServer(); openReader(page.id); showToast("File archived locally."); logEvent(`file imported · ${file.name}`);
    } catch (error) { showToast(error.message || "Could not import that file."); }
  };
  reader.readAsText(file);
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  $("searchInput").addEventListener("input", renderList); $("sortSelect").addEventListener("change", renderList);
  $("runTestsButton").addEventListener("click", runDiagnostics);
  $("themeSelect").addEventListener("change", (event) => { applyTheme(event.target.value); logEvent(`theme changed · ${event.target.value}`); });
  $("adminToken").value = localStorage.getItem("quietweb-admin-token") || "";
  $("broadcastButton").disabled = !$("adminToken").value;
  $("adminToken").addEventListener("input", async (event) => { const token = event.target.value.trim(); localStorage.setItem("quietweb-admin-token", token); $("broadcastButton").disabled = !token; $("adminStatus").textContent = token ? "Token entered. The server will validate it when you broadcast." : "Admin token required to broadcast."; if (token) { try { await syncToServer(); $("adminStatus").textContent = "Token accepted and library synced to the host."; } catch (error) { $("adminStatus").textContent = "Token saved, but the server rejected the library sync."; } } });
  $("adminForm").addEventListener("submit", async (event) => { event.preventDefault(); try { await sendAnnouncement($("announcementInput").value.trim()); } catch (error) { $("adminStatus").textContent = error.message; } });
  $("consoleForm").addEventListener("submit", (event) => { event.preventDefault(); const input = $("consoleInput"); const command = input.value; input.value = ""; runConsoleCommand(command); });
  $("filterButton").addEventListener("click", () => { const panel = $("filterPanel"); panel.hidden = !panel.hidden; $("filterButton").setAttribute("aria-expanded", String(!panel.hidden)); });
  document.querySelectorAll(".filter-chip").forEach((chip) => chip.addEventListener("click", () => { state.activeFilter = chip.dataset.filter; document.querySelectorAll(".filter-chip").forEach((item) => item.classList.toggle("active", item === chip)); renderList(); }));
  $("entryForm").addEventListener("submit", async (event) => { event.preventDefault(); try { if (window.__pendingSnapshot) { const original = saveEntry; window.__saveWithSnapshot = true; } await saveEntry(); if (window.__saveWithSnapshot) window.__saveWithSnapshot = false; } catch (error) { setStatus(error.message); } });
  $("fetchButton").addEventListener("click", async () => { try { await fetchIntoForm(); } catch (error) { setStatus(error.message + " You can still save the URL as a bookmark."); } });
  $("clearFormButton").addEventListener("click", clearForm); $("fileInput").addEventListener("change", (event) => { importFile(event.target.files[0]); event.target.value = ""; });
  $("exportButton").addEventListener("click", () => { const blob = new Blob([JSON.stringify({ version: 1, exported: new Date().toISOString(), pages: state.pages }, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "quietweb-library.json"; link.click(); URL.revokeObjectURL(link.href); showToast("Library exported."); });
  $("importButton").addEventListener("click", () => $("libraryFileInput").click()); $("libraryFileInput").addEventListener("change", (event) => { importFile(event.target.files[0]); event.target.value = ""; });
  $("dropzone").addEventListener("dragover", (event) => { event.preventDefault(); $("dropzone").classList.add("dragging"); }); $("dropzone").addEventListener("dragleave", () => $("dropzone").classList.remove("dragging")); $("dropzone").addEventListener("drop", (event) => { event.preventDefault(); $("dropzone").classList.remove("dragging"); importFile(event.dataTransfer.files[0]); });
  window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); state.deferredInstall = event; $("installButton").hidden = false; }); $("installButton").addEventListener("click", async () => { if (!state.deferredInstall) return; state.deferredInstall.prompt(); await state.deferredInstall.userChoice; state.deferredInstall = null; $("installButton").hidden = true; });
  refreshServerStatus(); setInterval(refreshServerStatus, 15000); setInterval(syncFromServer, 20000);
}

function registerPWA() { if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js?v=5", { updateViaCache: "none" }).catch(() => {}); }

init().catch(() => { $("pageList").innerHTML = '<div class="empty-state"><strong>Local storage is unavailable.</strong><span>Try serving this app from localhost or HTTPS.</span></div>'; });