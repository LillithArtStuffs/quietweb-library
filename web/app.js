const DB_NAME = "quietweb-library";
const DB_VERSION = 1;
const STORE = "pages";
const BUILD = "0.4";
const TOMBSTONE_KEY = "quietweb-tombstones";
const VIEWS = ["library", "add", "reader", "diagnostics"];
const THEMES = ["dark", "light", "teto", "wire"];
const THEME_OPTIONS = [...THEMES, "system"];
const THEME_COLORS = { dark: "#0d2d38", light: "#173d48", teto: "#5d315f", wire: "#0a1114" };
const LIGHT_QUERY = "(prefers-color-scheme: light)";

const state = {
  pages: [],
  activeFilter: "all",
  selectedId: null,
  editingId: null,
  pendingSnapshot: "",
  deferredInstall: null,
  storageReady: false,
  serverOnline: false,
  lastDeleted: null
};

let lastAnnouncement = "";
let lastServerState = "unknown";
let lastSharedSignature = "";
let searchTimer = null;

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

/* ---------------------------------------------------------------- startup */

async function init() {
  applyTheme(localStorage.getItem("quietweb-theme") || "dark");
  state.pages = await getAll();
  state.storageReady = true;
  if (!state.pages.length) {
    state.pages = [
      makePage("Welcome to quietweb", "start here", "This is your local reading room. Save a web snapshot, bookmark a source, or write a note.\n\nThe browser stores your collection on this device, and the app shell can be installed for offline use.\n\nPress ? at any time for the keyboard shortcuts.", "note"),
      makePage("A small offline kit", "field notes", "Keep only what you return to: maps, guides, recipes, references, and project notes. A useful archive is selective and easy to search.", "note")
    ];
    await Promise.all(state.pages.map(put));
  }
  bindEvents();
  logEvent(`ready · build ${BUILD} · ${state.pages.length} pages loaded · theme ${document.documentElement.dataset.theme}`);
  await syncFromServer();
  renderList();
  routeFromHash();
  registerPWA();
}

function makePage(title, tag, content, type = "note", url = "", html = "") {
  const created = new Date().toISOString();
  return { id: "page-" + crypto.randomUUID(), title, tag: tag || "untagged", content, type, url, html, created, updated: created, size: sizeOf(content, html) };
}

const sizeOf = (content, html) => String(content || "").length + String(html || "").length;

/* ------------------------------------------------------------- navigation */

function showView(name) {
  if (!VIEWS.includes(name)) name = "library";
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === name + "View"));
  if (name === "library") renderList();
  if (name !== "add") exitEditMode();
  if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function routeFromHash() {
  const target = location.hash.slice(1);
  if (VIEWS.includes(target) && target !== "reader") showView(target);
}

/* ------------------------------------------------------------ diagnostics */

function renderTest(test) {
  const icon = { pass: "✓", warn: "!", fail: "×" }[test.status];
  return `<article class="test-result ${test.status}"><span class="test-icon">${icon}</span><div><strong>${escapeHtml(test.name)}</strong><p>${escapeHtml(test.detail)}</p></div><span class="test-time">${test.duration} ms</span></article>`;
}

async function runDiagnostics() {
  const tests = [];
  const check = async (name, action) => {
    const started = performance.now();
    try {
      const outcome = await action();
      const detail = typeof outcome === "string" ? outcome : outcome.detail;
      const status = typeof outcome === "string" ? "pass" : outcome.status;
      tests.push({ name, status, detail, duration: Math.round(performance.now() - started) });
    } catch (error) {
      tests.push({ name, status: "fail", detail: error.message || "Check failed", duration: Math.round(performance.now() - started) });
    }
  };

  await check("IndexedDB archive", async () => {
    const probe = makePage("__diagnostic__", "test", "ok");
    await put(probe);
    const found = (await store("readonly", (items) => items.get(probe.id)))?.title === "__diagnostic__";
    await remove(probe.id);
    if (!found) throw new Error("The browser could not write and read a test record.");
    return "Local page storage is working.";
  });

  await check("Storage headroom", async () => {
    if (!navigator.storage?.estimate) return { status: "warn", detail: "This browser does not report a storage quota. Export regularly." };
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const used = formatBytes(usage);
    if (!quota) return { status: "warn", detail: `Using ${used}. No quota reported by the browser.` };
    const share = Math.round((usage / quota) * 100);
    const detail = `Using ${used} of roughly ${formatBytes(quota)} (${share}%).`;
    return share > 85 ? { status: "warn", detail: detail + " Export and prune soon." } : detail;
  });

  await check("Service worker support", async () => {
    if (!("serviceWorker" in navigator)) throw new Error("This browser does not support service workers.");
    if (!window.isSecureContext) return { status: "warn", detail: "Supported, but this page is not a secure context, so offline caching stays off." };
    const registration = await navigator.serviceWorker.getRegistration();
    return registration ? "Registered. The app shell is cached for offline use." : { status: "warn", detail: "Supported but not registered yet. Reload once to install it." };
  });

  await check("Installable app manifest", async () => {
    const response = await fetch("manifest.webmanifest", { cache: "no-store" });
    if (!response.ok) throw new Error("Manifest returned HTTP " + response.status + ".");
    const manifest = await response.json();
    if (!manifest.name || !manifest.start_url) throw new Error("Manifest is missing required fields.");
    if (!manifest.icons?.length) throw new Error("Manifest has no icons, so the browser will not offer to install it.");
    return `The install manifest is reachable with ${manifest.icons.length} icons.`;
  });

  await check("File import capability", async () => {
    if (!("FileReader" in window) || !("DOMParser" in window)) throw new Error("File import APIs are unavailable.");
    return "HTML, text, and library imports are supported.";
  });

  await check("Archive fetching", async () => {
    if (state.serverOnline) return "The Quietweb server is up and will fetch pages on your behalf.";
    return { status: "warn", detail: "No server detected. Saving, reading, and importing work; fetching a live URL usually will not, because browsers block cross-site requests." };
  });

  await check("App context", async () => {
    if (window.isSecureContext) return `Secure context (${location.protocol}//${location.host}). All features available.`;
    return { status: "warn", detail: `Served over plain ${location.protocol}//${location.host}. The library works, but install and offline caching need localhost or HTTPS.` };
  });

  $("testResults").innerHTML = tests.map(renderTest).join("");
  const passed = tests.filter((test) => test.status === "pass").length;
  const warned = tests.filter((test) => test.status === "warn").length;
  const failed = tests.filter((test) => test.status === "fail").length;
  $("diagnosticSummary").textContent = `${passed} passed · ${warned} warnings · ${failed} failed`;
  return $("diagnosticSummary").textContent;
}

/* ------------------------------------------------------------------- list */

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
    if (sort === "oldest") return String(a.created).localeCompare(String(b.created));
    if (sort === "size") return (b.size || 0) - (a.size || 0);
    return String(b.created).localeCompare(String(a.created));
  });
}

function renderList() {
  const pages = visiblePages();
  const query = $("searchInput").value.trim();
  $("resultCount").textContent = `${pages.length} of ${state.pages.length} · ${formatBytes(state.pages.reduce((total, page) => total + (page.size || 0), 0))}`;
  $("filterCount").textContent = state.activeFilter === "all" ? "" : "· 1";
  $("pageList").innerHTML = pages.length ? pages.map((page) => `
    <article class="page-row" data-id="${escapeHtml(page.id)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(page.title)}">
      <div><button class="page-row-tag" data-tag="${escapeHtml(page.tag)}" title="Search this tag">${escapeHtml(page.tag)}</button><span class="row-type">${typeLabel(page)}</span></div>
      <div><h3>${escapeHtml(page.title)}</h3><p>${escapeHtml(preview(page.content))}</p></div>
      <time class="page-row-date" datetime="${escapeHtml(page.created)}">${formatDate(page.created)}</time>
    </article>`).join("") : emptyState(query);

  document.querySelectorAll(".page-row").forEach((row) => {
    row.addEventListener("click", (event) => { if (!event.target.closest("[data-tag]")) openReader(row.dataset.id); });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openReader(row.dataset.id); }
    });
  });
  document.querySelectorAll("[data-tag]").forEach((chip) => chip.addEventListener("click", () => {
    $("searchInput").value = chip.dataset.tag;
    renderList();
  }));
}

function emptyState(query) {
  if (query || state.activeFilter !== "all") {
    return `<div class="empty-state"><strong>Nothing matches that.</strong><span>Clear the search or filter to see the whole library.</span><button class="button subtle" id="resetFilters">Reset search and filters</button></div>`;
  }
  return `<div class="empty-state"><strong>No pages here yet.</strong><span>Add something to start your library.</span></div>`;
}

function typeLabel(page) {
  if (page.html) return "offline snapshot";
  return { bookmark: "bookmark", code: "source code", note: "note", snapshot: "snapshot" }[page.type] || "saved page";
}

function preview(content) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  return text.length > 145 ? text.slice(0, 145).replace(/\s+\S*$/, "") + "..." : text;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "undated";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

/* ---------------------------------------------------- syntax highlighting */

const PYTHON_KEYWORDS = "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" ");
const PYTHON_BUILTINS = "True False None self print len range str int float bool list dict set tuple enumerate zip open super Exception".split(" ");

const KEYWORDS = {
  javascript: "async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while yield".split(" "),
  python: PYTHON_KEYWORDS,
  // Ren'Py is Python plus its own script and screen statements.
  renpy: [...PYTHON_KEYWORDS, ..."label menu scene show hide play stop queue jump call screen transform image define init pause window voice nvl vbox hbox frame imagebutton textbutton".split(" ")],
  css: [],
  json: [],
  html: []
};

const BUILTINS = {
  javascript: "true false null undefined NaN Infinity console document window Math JSON Object Array String Number Boolean Promise Set Map Date RegExp localStorage fetch".split(" "),
  python: PYTHON_BUILTINS,
  renpy: [...PYTHON_BUILTINS, ..."renpy config store persistent style gui achievement".split(" ")],
  css: [],
  json: "true false null".split(" "),
  html: []
};

// Each grammar is an ordered list of [token, pattern]; earlier entries win, so
// comments and strings match before anything can look inside them.
const GRAMMARS = {
  javascript: [
    ["comment", String.raw`//[^\n]*|/\*[\s\S]*?\*/`],
    ["string", String.raw`\`(?:\\[\s\S]|[^\\\`])*\`|"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'`],
    ["number", String.raw`\b0[xXbBoO][\da-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b`],
    ["word", String.raw`[A-Za-z_$][\w$]*`],
    ["punct", String.raw`[{}()\[\];,.:+\-*/%=<>!&|?~^]+`]
  ],
  python: [
    ["comment", String.raw`#[^\n]*`],
    ["string", String.raw`[rbfuRBFU]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*')`],
    ["number", String.raw`\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b`],
    ["word", String.raw`[A-Za-z_][\w]*`],
    ["punct", String.raw`[{}()\[\];,.:+\-*/%=<>!&|?~^]+`]
  ],
  css: [
    ["comment", String.raw`/\*[\s\S]*?\*/`],
    ["string", String.raw`"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'`],
    ["number", String.raw`#[\da-fA-F]{3,8}\b|\b\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch)?\b`],
    ["word", String.raw`@?[A-Za-z_-][\w-]*`],
    ["punct", String.raw`[{}()\[\];,.:+\-*/%=<>!&|?~^]+`]
  ],
  json: [
    ["string", String.raw`"(?:\\[\s\S]|[^"\\])*"`],
    ["number", String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`],
    ["word", String.raw`\b(?:true|false|null)\b`],
    ["punct", String.raw`[{}()\[\];,.:+\-*/%=<>!&|?~^]+`]
  ],
  html: [
    ["comment", String.raw`<!--[\s\S]*?-->`],
    ["tag", String.raw`</?[A-Za-z][\w:-]*|/?>`],
    ["string", String.raw`"[^"]*"|'[^']*'`],
    ["attr", String.raw`[A-Za-z_:][\w:.-]*(?=\s*=)`],
    ["punct", String.raw`[{}()\[\];,.:+\-*/%=<>!&|?~^]+`]
  ]
};
GRAMMARS.renpy = GRAMMARS.python;

const EXTENSION_LANGUAGES = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "javascript", tsx: "javascript",
  py: "python", pyw: "python", rpy: "renpy",
  css: "css", json: "json", webmanifest: "json",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html"
};

function languageFromName(name) {
  return EXTENSION_LANGUAGES[String(name).split(".").pop().toLowerCase()] || "";
}

function guessLanguage(text) {
  const sample = String(text || "").slice(0, 4000);
  if (!sample.trim()) return "plain";
  if (/^\s*</.test(sample) && /<(!doctype|html|head|body|div|span|script|style|p|section)\b/i.test(sample)) return "html";
  if (/^\s*[{[]/.test(sample)) { try { JSON.parse(text); return "json"; } catch (error) { /* not JSON after all */ } }
  if (/^\s*(label\s+[\w.]+:|menu:|scene\s|show\s|init\s+python|define\s+\w+\s*=)/m.test(sample)) return "renpy";
  if (/^\s*(def\s|class\s+\w+[(:]|import\s+\w|from\s+[\w.]+\s+import|if\s+__name__)/m.test(sample)) return "python";
  if (/(^|[\s;{])(function\s|const\s|let\s|var\s|=>|require\(|export\s|import\s.+\sfrom\s)/.test(sample)) return "javascript";
  if (/[.#@][\w-]+[^{}]*\{[^{}]*:[^{}]*[;}]/.test(sample)) return "css";
  return "plain";
}

function languageFor(page) {
  return page.language || languageFromName(page.title) || guessLanguage(page.content);
}

function tokenize(code, language) {
  const grammar = GRAMMARS[language];
  if (!grammar) return [["plain", code]];
  const pattern = new RegExp(grammar.map(([name, source]) => `(?<${name}>${source})`).join("|"), "g");
  const keywords = KEYWORDS[language] || [];
  const builtins = BUILTINS[language] || [];
  const tokens = [];
  let cursor = 0;
  let match;
  while ((match = pattern.exec(code))) {
    if (match.index > cursor) tokens.push(["plain", code.slice(cursor, match.index)]);
    const name = Object.keys(match.groups).find((key) => match.groups[key] !== undefined);
    const text = match[0];
    let type = name;
    if (name === "word") {
      const next = code.slice(match.index + text.length).match(/^\s*(.)/)?.[1];
      if (keywords.includes(text)) type = "keyword";
      else if (builtins.includes(text)) type = "builtin";
      else if (language === "css") type = text.startsWith("@") || next === ":" ? "keyword" : "plain";
      else if (next === "(") type = "function";
      else type = "plain";
    }
    tokens.push([type, text]);
    cursor = match.index + text.length;
    if (!text.length) pattern.lastIndex += 1;
  }
  if (cursor < code.length) tokens.push(["plain", code.slice(cursor)]);
  return tokens;
}

const HIGHLIGHT_LIMIT = 200000;

// Builds nodes rather than markup, so highlighted source can never become HTML.
function renderCode(code, language) {
  const fragment = document.createDocumentFragment();
  if (code.length > HIGHLIGHT_LIMIT) {
    fragment.append(document.createTextNode(code));
    return fragment;
  }
  for (const [type, text] of tokenize(code, language)) {
    if (type === "plain") {
      fragment.append(document.createTextNode(text));
      continue;
    }
    const span = document.createElement("span");
    span.className = "syn-" + type;
    span.textContent = text;
    fragment.append(span);
  }
  return fragment;
}

/* ----------------------------------------------------------------- reader */

function openReader(id) {
  const page = state.pages.find((item) => item.id === id);
  if (!page) return;
  state.selectedId = id;
  $("readerTag").textContent = page.tag;
  $("readerTitle").textContent = page.title;
  const edited = page.updated && page.updated !== page.created ? ` · edited ${formatDate(page.updated)}` : "";
  const meta = $("readerMeta");
  meta.textContent = `${typeLabel(page)} · saved ${formatDate(page.created)}${edited} · ${formatBytes(page.size || 0)}`;

  const body = $("readerBody");
  body.className = "reader-body";
  body.innerHTML = "";
  if (page.html) {
    const frame = document.createElement("iframe");
    frame.title = "Offline page snapshot";
    frame.sandbox = "";
    frame.srcdoc = page.html;
    body.append(frame);
  } else if (page.type === "code") {
    const language = languageFor(page);
    body.classList.add("code");
    body.append(renderCode(page.content || "", language));
    if (language !== "plain") {
      const badge = document.createElement("span");
      badge.className = "code-language";
      badge.textContent = language;
      meta.append(badge);
    }
  } else {
    body.textContent = page.content || "This bookmark has no archived content yet.";
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

  $("readerActions").innerHTML = [
    `<button class="button subtle" data-reader-action="edit">Edit</button>`,
    `<button class="button subtle" data-reader-action="copy">Copy text</button>`,
    `<button class="button subtle" data-reader-action="download">Download</button>`,
    `<button class="button subtle" data-reader-action="fetch"${page.url ? "" : " disabled"}>Refresh snapshot</button>`,
    `<button class="button subtle danger" data-reader-action="delete">Delete</button>`
  ].join("");
  $("readerActions").querySelectorAll("button").forEach((button) =>
    button.addEventListener("click", () => handleReaderAction(button.dataset.readerAction, page)));
  showView("reader");
}

async function handleReaderAction(action, page) {
  try {
    if (action === "delete") return deletePage(page);
    if (action === "edit") return startEdit(page);
    if (action === "copy") return copyPage(page);
    if (action === "download") return downloadPage(page);
    await refreshSnapshot(page);
  } catch (error) {
    showToast(error.message || "That action failed.");
  }
}

async function copyPage(page) {
  const text = page.content || page.url || "";
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied the page text.");
  } catch (error) {
    // Clipboard access is often blocked outside a secure context, so fall back
    // to selecting the text and letting the reader copy it by hand.
    const range = document.createRange();
    range.selectNodeContents($("readerBody"));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    showToast("Clipboard blocked. The text is selected for you.");
  }
}

function downloadPage(page) {
  const isSnapshot = Boolean(page.html);
  const blob = new Blob([isSnapshot ? page.html : page.content || ""], { type: isSnapshot ? "text/html" : "text/plain" });
  saveBlob(blob, `${slug(page.title)}.${isSnapshot ? "html" : "txt"}`);
  showToast("Downloaded.");
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "quietweb-page";
}

function saveBlob(blob, filename) {
  const link = document.createElement("a");
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  // Tearing the anchor down in the same tick can cancel the download, which
  // iOS Safari in particular is unforgiving about.
  setTimeout(() => { link.remove(); URL.revokeObjectURL(href); }, 4000);
}

async function deletePage(page) {
  await remove(page.id);
  state.pages = state.pages.filter((item) => item.id !== page.id);
  addTombstone(page.id);
  state.lastDeleted = page;
  await syncToServer();
  logEvent(`deleted · ${page.title}`);
  showToast(`Deleted "${preview(page.title)}".`, { label: "Undo", action: () => undoDelete() });
  showView("library");
}

async function undoDelete() {
  const page = state.lastDeleted;
  if (!page) return;
  state.lastDeleted = null;
  removeTombstone(page.id);
  await put(page);
  state.pages.unshift(page);
  await syncToServer();
  renderList();
  logEvent(`restored · ${page.title}`);
  showToast("Restored.");
}

/* ------------------------------------------------------------ add / edit */

function startEdit(page) {
  state.editingId = page.id;
  state.pendingSnapshot = "";
  $("titleInput").value = page.title;
  $("tagInput").value = page.tag;
  $("urlInput").value = page.url || "";
  $("contentInput").value = page.content || "";
  $("typeInput").value = page.type || "note";
  $("addKicker").textContent = "Editing";
  $("addHeading").textContent = "Change what you kept.";
  $("addLede").textContent = page.html ? "This page has an offline snapshot. Editing the text leaves the snapshot in place." : "Update the title, tag, or text and save it back to the library.";
  $("saveEntryButton").textContent = "Save changes";
  $("clearFormButton").textContent = "Cancel edit";
  setStatus("");
  showViewKeepingEdit("add");
}

function showViewKeepingEdit(name) {
  const editing = state.editingId;
  showView(name);
  state.editingId = editing;
}

function exitEditMode() {
  if (!state.editingId) return;
  state.editingId = null;
  $("addKicker").textContent = "New entry";
  $("addHeading").textContent = "Put something aside.";
  $("addLede").textContent = "Archive a readable page, save a bookmark, or write a note for later.";
  $("saveEntryButton").textContent = "Save to library";
  $("clearFormButton").textContent = "Clear";
}

async function saveEntry() {
  const title = $("titleInput").value.trim();
  const tag = $("tagInput").value.trim() || "untagged";
  const url = normalizeUrl($("urlInput").value.trim());
  const content = $("contentInput").value.trim();
  const type = $("typeInput").value;
  if (!title || (!content && !url)) throw new Error("Add a title and either content or a URL.");

  if (state.editingId) {
    const page = state.pages.find((item) => item.id === state.editingId);
    if (!page) throw new Error("That page is no longer in the library.");
    Object.assign(page, { title, tag, url, content, type, updated: new Date().toISOString() });
    if (type === "code" && !page.language) page.language = guessLanguage(content);
    if (state.pendingSnapshot) { page.html = state.pendingSnapshot; page.type = "snapshot"; }
    page.size = sizeOf(page.content, page.html);
    await put(page);
    await syncToServer();
    logEvent(`updated · ${title}`);
    const id = page.id;
    clearForm();
    showToast("Changes saved.");
    openReader(id);
    return;
  }

  const page = makePage(title, tag, content || "Bookmark saved. Archive the source when you are online.", type, url);
  if (state.pendingSnapshot) {
    page.html = state.pendingSnapshot;
    page.type = "snapshot";
    page.size = sizeOf(page.content, page.html);
  }
  await put(page);
  state.pages.unshift(page);
  await syncToServer();
  logEvent(`saved · ${title}`);
  clearForm();
  showToast("Saved to your local library.");
  showView("library");
}

function clearForm() {
  ["titleInput", "tagInput", "urlInput", "contentInput"].forEach((id) => { $(id).value = ""; });
  $("typeInput").value = "snapshot";
  $("entryStatus").textContent = "";
  state.pendingSnapshot = "";
  exitEditMode();
}

/* ---------------------------------------------------------------- fetching */

async function fetchSnapshot(url) {
  // Browsers block cross-site reads, so the local Python helper does the
  // fetching whenever it is running. The direct attempt is only a fallback for
  // static deployments and same-origin URLs.
  let serverMessage = "";
  try {
    const response = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `The server returned ${response.status}.`);
    if (!payload.snapshot) throw new Error("The server returned an empty snapshot.");
    return { html: sanitizeHtml(payload.snapshot), title: payload.title || "", via: "server" };
  } catch (error) {
    serverMessage = error.message || String(error);
  }
  try {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) throw new Error(`The source returned ${response.status}.`);
    const raw = await response.text();
    const parsed = new DOMParser().parseFromString(raw, "text/html");
    return { html: sanitizeHtml(raw), title: parsed.title || "", via: "browser" };
  } catch (error) {
    throw new Error(state.serverOnline
      ? `Could not archive that page. ${serverMessage}`
      : "Could not archive that page. Browsers block cross-site fetches, so start Quietweb with one of the scripts/ launchers and let the local server fetch it for you.");
  }
}

async function fetchIntoForm() {
  const url = normalizeUrl($("urlInput").value.trim());
  if (!url) throw new Error("Add a complete http:// or https:// URL first.");
  setStatus("Fetching and preparing a local snapshot...");
  const { html, title, via } = await fetchSnapshot(url);
  const readable = textFromDocument(new DOMParser().parseFromString(html, "text/html"));
  if (!readable) throw new Error("The source did not contain readable text.");
  if (!$("titleInput").value.trim()) $("titleInput").value = title || url;
  $("contentInput").value = readable;
  $("typeInput").value = "snapshot";
  state.pendingSnapshot = html;
  setStatus(`Ready (${formatBytes(html.length)} via ${via === "server" ? "the local server" : "the browser"}). Save to keep this snapshot on the device.`);
  logEvent(`fetched · ${url} · via ${via}`);
}

async function refreshSnapshot(page) {
  if (!page.url) return;
  showToast("Fetching a fresh snapshot...");
  const { html } = await fetchSnapshot(page.url);
  page.html = html;
  page.content = textFromDocument(new DOMParser().parseFromString(html, "text/html")) || page.content;
  page.updated = new Date().toISOString();
  page.size = sizeOf(page.content, page.html);
  await put(page);
  await syncToServer();
  openReader(page.id);
  showToast("Snapshot refreshed.");
  logEvent(`snapshot refreshed · ${page.title}`);
}

function sanitizeHtml(rawHtml) {
  const documentCopy = new DOMParser().parseFromString(rawHtml, "text/html");
  documentCopy.querySelectorAll("script, noscript, iframe, object, embed, form, input, button, link[rel=\"import\"]").forEach((element) => element.remove());
  documentCopy.querySelectorAll("*").forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const isEventHandler = name.startsWith("on");
      const isScriptUrl = /^\s*javascript:/i.test(attribute.value) && ["href", "src", "action", "xlink:href"].includes(name);
      if (isEventHandler || isScriptUrl || name === "srcdoc") element.removeAttribute(attribute.name);
    });
  });
  documentCopy.querySelectorAll("a").forEach((link) => { link.target = "_blank"; link.rel = "noopener noreferrer"; });
  const styles = [...documentCopy.querySelectorAll("style")].map((style) => style.outerHTML).join("\n");
  const body = documentCopy.body ? documentCopy.body.innerHTML : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:24px;font-family:system-ui,Arial,sans-serif;line-height:1.6;color:#202426}img{max-width:100%;height:auto}pre{overflow:auto;padding:12px;background:#eee}</style>${styles}</head><body>${body}</body></html>`;
}

const BLOCK_TAGS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "MAIN", "OL", "P", "PRE", "SECTION", "TABLE", "TD", "TH", "TR", "UL"]);

function textFromDocument(documentCopy) {
  documentCopy.querySelectorAll("script,style,noscript,nav,footer,header,svg,template").forEach((element) => element.remove());
  const body = documentCopy.body;
  if (!body) return "";
  // innerText returns "" for documents that were never rendered (notably in
  // WebKit), so walk the tree and place the line breaks ourselves.
  let text = "";
  const walk = (node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.nodeValue.replace(/\s+/g, " ");
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const isBlock = BLOCK_TAGS.has(child.tagName);
        if (isBlock && !text.endsWith("\n")) text += "\n";
        walk(child);
        if (isBlock) text += "\n";
      }
    });
  };
  walk(body);
  return text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeUrl(value) {
  if (!value) return "";
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : "https://" + value);
  } catch (error) {
    throw new Error("That does not look like a URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http:// and https:// links are supported.");
  return url.href;
}

/* ------------------------------------------------------------------- chrome */

function setStatus(message) { $("entryStatus").textContent = message; }

function showToast(message, action) {
  const toast = $("toast");
  toast.innerHTML = "";
  toast.append(document.createTextNode(message));
  if (action) {
    const button = document.createElement("button");
    button.className = "toast-action";
    button.textContent = action.label;
    button.addEventListener("click", () => { toast.classList.remove("show"); action.action(); });
    toast.append(button);
  }
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), action ? 8000 : 3000);
}

// The stored value is the *preference*, which may be "system"; data-theme is
// always a concrete theme so the stylesheet never has to resolve anything.
function applyTheme(preference) {
  const chosen = THEME_OPTIONS.includes(preference) ? preference : "dark";
  const resolved = chosen === "system" ? (matchMedia(LIGHT_QUERY).matches ? "light" : "dark") : chosen;
  document.documentElement.dataset.theme = resolved;
  if ($("themeSelect")) $("themeSelect").value = chosen;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLORS[resolved];
  localStorage.setItem("quietweb-theme", chosen);
  return resolved;
}

function logEvent(message) {
  const output = $("consoleOutput");
  if (!output) return;
  const timestamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  output.textContent += `\n[${timestamp}] ${message}`;
  // Keep the console from growing without bound over a long session.
  const lines = output.textContent.split("\n");
  if (lines.length > 300) output.textContent = lines.slice(-300).join("\n");
  output.scrollTop = output.scrollHeight;
}

/* -------------------------------------------------------------------- sync */

function readTombstones() {
  try { return new Set(JSON.parse(localStorage.getItem(TOMBSTONE_KEY) || "[]")); }
  catch (error) { return new Set(); }
}

function writeTombstones(ids) {
  // Cap the list so a long-lived install cannot fill localStorage with ids.
  try { localStorage.setItem(TOMBSTONE_KEY, JSON.stringify([...ids].slice(-500))); } catch (error) { /* quota */ }
}

function addTombstone(id) { const ids = readTombstones(); ids.add(id); writeTombstones(ids); }
function removeTombstone(id) { const ids = readTombstones(); ids.delete(id); writeTombstones(ids); }

function mergePages(localPages, remotePages) {
  const deleted = readTombstones();
  const byId = new Map();
  const stamp = (page) => String(page.updated || page.created || "");
  [...localPages, ...remotePages].forEach((page) => {
    if (!page?.id || deleted.has(page.id)) return;
    const existing = byId.get(page.id);
    // Last write wins, so a page edited on another device survives the merge.
    if (!existing || stamp(page) > stamp(existing)) byId.set(page.id, { ...page, size: page.size ?? sizeOf(page.content, page.html) });
  });
  return [...byId.values()];
}

function sharedSignature(pages) {
  return JSON.stringify(pages.map((page) => `${page.id}:${page.updated || page.created}:${page.size}`).sort());
}

async function syncFromServer() {
  try {
    const response = await fetch("/api/library", { cache: "no-store" });
    if (!response.ok) throw new Error("Shared library unavailable");
    const remote = await response.json();
    const remotePages = Array.isArray(remote.pages) ? remote.pages : [];
    const signature = sharedSignature(remotePages);
    if (signature === lastSharedSignature) return;
    lastSharedSignature = signature;

    const merged = mergePages(state.pages, remotePages);
    const changed = sharedSignature(merged) !== sharedSignature(state.pages);
    if (changed) {
      state.pages = merged;
      await Promise.all(merged.map(put));
      renderList();
      logEvent(`shared library merged · ${merged.length} pages`);
    }
    // Push local-only pages and deletions back up when we hold the token.
    if (localStorage.getItem("quietweb-admin-token") && sharedSignature(merged) !== signature) await syncToServer();
  } catch (error) {
    logEvent("shared library unavailable · using local copy");
  }
}

async function syncToServer() {
  const token = localStorage.getItem("quietweb-admin-token");
  if (!token) return;
  try {
    const response = await fetch("/api/library", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Quietweb-Admin": token },
      body: JSON.stringify({ pages: state.pages })
    });
    if (!response.ok) throw new Error("Shared library write rejected. Check the admin token.");
    lastSharedSignature = sharedSignature(state.pages);
    logEvent(`shared library saved · ${state.pages.length} pages`);
  } catch (error) {
    // A failed host sync must never lose the local write that triggered it.
    logEvent(`shared library sync failed · ${error.message}`);
  }
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days ? days + "d " : ""}${hours}h ${minutes}m ${seconds % 60}s`;
}

async function refreshServerStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("offline");
    const status = await response.json();
    state.serverOnline = true;
    const connection = $("connectionState");
    connection.className = state.storageReady ? "connection online" : "connection degraded";
    connection.innerHTML = `<i></i> ${state.storageReady ? "All systems ready" : "Storage issue"} · ${formatUptime(status.uptime || 0)}`;
    connection.title = `${status.runtime || "Server"} at ${location.hostname}:${status.port || location.port}`;
    $("serverBadge").textContent = "Server connected";
    $("serverBadge").classList.add("online");
    $("serverUptime").textContent = formatUptime(status.uptime || 0);
    $("serverRuntime").textContent = status.runtime || "unknown";
    $("serverAddress").textContent = `${location.hostname}:${status.port || location.port}`;
    $("serverNotice").hidden = true;
    if (status.announcement?.message !== undefined && status.announcement.message !== lastAnnouncement) {
      lastAnnouncement = status.announcement.message;
      $("announcementText").textContent = lastAnnouncement;
      $("announcementBanner").hidden = !lastAnnouncement;
      if (lastAnnouncement) showToast("New server announcement");
    }
    const nextServerState = state.storageReady ? "ready" : "storage-issue";
    if (nextServerState !== lastServerState) logEvent(`server online · ${state.storageReady ? "all systems ready" : "storage issue"}`);
    lastServerState = nextServerState;
  } catch (error) {
    state.serverOnline = false;
    const connection = $("connectionState");
    connection.className = state.storageReady ? "connection degraded" : "connection offline";
    connection.innerHTML = `<i></i> ${state.storageReady ? "Browser-only mode" : "Storage unavailable"}`;
    connection.title = "No local Quietweb server detected. Imported and saved content still works.";
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
  const response = await fetch("/api/admin/announcement", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Quietweb-Admin": token },
    body: JSON.stringify({ message })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The server rejected the announcement.");
  localStorage.setItem("quietweb-admin-token", token);
  lastAnnouncement = result.message;
  $("announcementText").textContent = result.message;
  $("announcementBanner").hidden = !result.message;
  $("adminStatus").textContent = result.message ? "Broadcast sent to connected viewers." : "Announcement cleared.";
}

/* ---------------------------------------------------------------- console */

function writeConsole(line) {
  const output = $("consoleOutput");
  output.textContent += `\n${line}`;
  output.scrollTop = output.scrollHeight;
}

const CONSOLE_COMMANDS = {
  help: () => writeConsole("commands: help, status, pages, tags, tests, sync, export, theme <name>, find <text>, clear, version"),
  version: () => writeConsole(`quietweb build ${BUILD} · ${navigator.userAgent}`),
  status: async () => {
    writeConsole(`pages: ${state.pages.length} | archive: ${formatBytes(state.pages.reduce((total, page) => total + (page.size || 0), 0))} | storage: IndexedDB | origin: ${location.origin}`);
    writeConsole(`server: ${state.serverOnline ? "connected" : "static/browser-only mode"} | secure context: ${window.isSecureContext}`);
  },
  pages: () => {
    const rows = visiblePages().slice(0, 20);
    if (!rows.length) return writeConsole("no pages match the current search and filter");
    rows.forEach((page) => writeConsole(`  ${formatDate(page.created).padEnd(14)} ${typeLabel(page).padEnd(18)} ${page.title}`));
    if (visiblePages().length > rows.length) writeConsole(`  ...and ${visiblePages().length - rows.length} more`);
  },
  tags: () => {
    const counts = new Map();
    state.pages.forEach((page) => counts.set(page.tag, (counts.get(page.tag) || 0) + 1));
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    writeConsole(sorted.length ? sorted.map(([tag, count]) => `${tag} (${count})`).join(" · ") : "no tags yet");
  },
  tests: async () => writeConsole(await runDiagnostics()),
  sync: async () => { await syncToServer(); await syncFromServer(); writeConsole("sync attempted · see the log above for the result"); },
  export: () => { exportLibrary(); writeConsole("export started"); },
  clear: () => { $("consoleOutput").textContent = "Console cleared."; },
  theme: (argument) => {
    const options = THEME_OPTIONS.join(", ");
    if (!argument) return writeConsole(`theme: ${document.documentElement.dataset.theme} · options: ${options}`);
    const wanted = argument.trim().toLowerCase();
    if (!THEME_OPTIONS.includes(wanted)) return writeConsole(`unknown theme "${wanted}" · options: ${options}`);
    const resolved = applyTheme(wanted);
    writeConsole(wanted === "system" ? `following the system theme · now ${resolved}` : `theme set to ${resolved}`);
  },
  find: (argument) => {
    if (!argument) return writeConsole("usage: find <text>");
    $("searchInput").value = argument;
    renderList();
    showView("library");
    writeConsole(`searching for "${argument}" · ${visiblePages().length} matches`);
  }
};

async function runConsoleCommand(input) {
  const trimmed = input.trim();
  if (!trimmed) return;
  writeConsole(`> ${trimmed}`);
  const [name, ...rest] = trimmed.split(/\s+/);
  const command = CONSOLE_COMMANDS[name.toLowerCase()];
  if (!command) return writeConsole("Unknown command. Type help for the safe command list.");
  try { await command(rest.join(" ")); }
  catch (error) { writeConsole(`error: ${error.message}`); }
}

/* --------------------------------------------------------- import / export */

function exportLibrary() {
  const blob = new Blob([JSON.stringify({ version: 2, build: BUILD, exported: new Date().toISOString(), pages: state.pages }, null, 2)], { type: "application/json" });
  saveBlob(blob, `quietweb-library-${new Date().toISOString().slice(0, 10)}.json`);
  showToast(`Exported ${state.pages.length} pages.`);
}

function importFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => showToast("That file could not be read.");
  reader.onload = async () => {
    try {
      if (/\.json$/i.test(file.name)) return await importLibrary(String(reader.result));
      const raw = String(reader.result);
      const isHtml = /\.html?$/i.test(file.name) || /<html[\s>]/i.test(raw);
      const html = isHtml ? sanitizeHtml(raw) : "";
      const content = isHtml ? textFromDocument(new DOMParser().parseFromString(html, "text/html")) : raw.trim();
      if (!content && !html) throw new Error("That file is empty.");
      const declared = languageFromName(file.name);
      const type = isHtml ? "snapshot" : declared || /\.(sh|java|c|cpp|rb|go|rs|rpy|toml|yml|yaml)$/i.test(file.name) ? "code" : "note";
      const page = makePage(file.name.replace(/\.[^.]+$/, ""), "imported", content, type, "", html);
      if (declared) page.language = declared;
      await put(page);
      state.pages.unshift(page);
      await syncToServer();
      openReader(page.id);
      showToast("File archived locally.");
      logEvent(`file imported · ${file.name}`);
    } catch (error) {
      showToast(error.message || "Could not import that file.");
    }
  };
  reader.readAsText(file);
}

async function importLibrary(text) {
  const incoming = JSON.parse(text);
  const pages = Array.isArray(incoming) ? incoming : incoming.pages;
  if (!Array.isArray(pages)) throw new Error("Not a library export.");
  const usable = pages.filter((page) => page && page.title && (page.content || page.html || page.url));
  if (!usable.length) throw new Error("That export has no usable pages.");
  const existing = new Set(state.pages.map((page) => page.id));
  let added = 0;
  const prepared = usable.map((page) => {
    const created = page.created || new Date().toISOString();
    const id = page.id || "page-" + crypto.randomUUID();
    if (!existing.has(id)) added += 1;
    removeTombstone(id);
    return { ...page, id, created, updated: page.updated || created, tag: page.tag || "imported", size: page.size ?? sizeOf(page.content, page.html) };
  });
  await Promise.all(prepared.map(put));
  state.pages = mergePages(state.pages, prepared);
  renderList();
  await syncToServer();
  showToast(`Imported ${prepared.length} pages (${added} new).`);
  logEvent(`library imported · ${prepared.length} pages · ${added} new`);
}

/* --------------------------------------------------------------- shortcuts */

function isTyping(target) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

function handleShortcut(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const activeView = document.querySelector(".view.active")?.id.replace("View", "");

  if (event.key === "Escape") {
    if (isTyping(event.target)) { event.target.blur(); return; }
    if (activeView !== "library") showView("library");
    return;
  }
  if (isTyping(event.target)) return;

  if (event.key === "/") { event.preventDefault(); $("searchInput").focus(); $("searchInput").select(); return; }
  if (event.key === "n") { event.preventDefault(); showView("add"); $("titleInput").focus(); return; }
  if (event.key === "d") { event.preventDefault(); showView("diagnostics"); return; }
  if (event.key === "e" && activeView === "reader" && state.selectedId) {
    event.preventDefault();
    const page = state.pages.find((item) => item.id === state.selectedId);
    if (page) startEdit(page);
    return;
  }
  if (event.key === "?") { event.preventDefault(); $("shortcutHelp").hidden = !$("shortcutHelp").hidden; }
}

/* ------------------------------------------------------------------- wiring */

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  window.addEventListener("hashchange", routeFromHash);
  document.addEventListener("keydown", handleShortcut);

  $("searchInput").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderList, 120); });
  $("searchInput").addEventListener("search", renderList);
  $("sortSelect").addEventListener("change", renderList);
  $("pageList").addEventListener("click", (event) => {
    if (event.target.id !== "resetFilters") return;
    $("searchInput").value = "";
    state.activeFilter = "all";
    document.querySelectorAll(".filter-chip").forEach((chip) => chip.classList.toggle("active", chip.dataset.filter === "all"));
    renderList();
  });

  $("runTestsButton").addEventListener("click", runDiagnostics);
  $("themeSelect").addEventListener("change", (event) => {
    const resolved = applyTheme(event.target.value);
    logEvent(`theme changed · ${event.target.value}${event.target.value === "system" ? ` (${resolved})` : ""}`);
  });
  // Follow the OS only while the reader actually asked us to.
  matchMedia(LIGHT_QUERY).addEventListener("change", () => {
    if (localStorage.getItem("quietweb-theme") === "system") applyTheme("system");
  });
  $("dismissAnnouncement").addEventListener("click", () => { $("announcementBanner").hidden = true; });

  $("adminToken").value = localStorage.getItem("quietweb-admin-token") || "";
  $("broadcastButton").disabled = !$("adminToken").value;
  $("adminToken").addEventListener("input", async (event) => {
    const token = event.target.value.trim();
    localStorage.setItem("quietweb-admin-token", token);
    $("broadcastButton").disabled = !token;
    $("adminStatus").textContent = token ? "Token entered. The server will validate it when you broadcast." : "Admin token required to broadcast.";
    if (token) { await syncToServer(); $("adminStatus").textContent = "Token saved. Check the console for the sync result."; }
  });
  $("adminForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try { await sendAnnouncement($("announcementInput").value.trim()); }
    catch (error) { $("adminStatus").textContent = error.message; }
  });

  $("consoleForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("consoleInput");
    const command = input.value;
    input.value = "";
    runConsoleCommand(command);
  });

  $("filterButton").addEventListener("click", () => {
    const panel = $("filterPanel");
    panel.hidden = !panel.hidden;
    $("filterButton").setAttribute("aria-expanded", String(!panel.hidden));
  });
  document.querySelectorAll(".filter-chip").forEach((chip) => chip.addEventListener("click", () => {
    state.activeFilter = chip.dataset.filter;
    document.querySelectorAll(".filter-chip").forEach((item) => item.classList.toggle("active", item === chip));
    renderList();
  }));

  $("entryForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("saveEntryButton");
    button.disabled = true;
    try { await saveEntry(); }
    catch (error) { setStatus(error.message); }
    finally { button.disabled = false; }
  });
  $("fetchButton").addEventListener("click", async () => {
    const button = $("fetchButton");
    button.disabled = true;
    try { await fetchIntoForm(); }
    catch (error) { setStatus(error.message + " You can still save the URL as a bookmark."); }
    finally { button.disabled = false; }
  });
  $("clearFormButton").addEventListener("click", () => { const editing = state.editingId; clearForm(); if (editing) openReader(editing); });

  $("fileInput").addEventListener("change", (event) => { importFile(event.target.files[0]); event.target.value = ""; });
  $("exportButton").addEventListener("click", exportLibrary);
  $("importButton").addEventListener("click", () => $("libraryFileInput").click());
  $("libraryFileInput").addEventListener("change", (event) => { importFile(event.target.files[0]); event.target.value = ""; });

  const dropzone = $("dropzone");
  dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("dragging"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
    importFile(event.dataTransfer?.files?.[0]);
  });

  window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); state.deferredInstall = event; $("installButton").hidden = false; });
  $("installButton").addEventListener("click", async () => {
    if (!state.deferredInstall) return;
    state.deferredInstall.prompt();
    await state.deferredInstall.userChoice;
    state.deferredInstall = null;
    $("installButton").hidden = true;
  });

  refreshServerStatus();
  setInterval(refreshServerStatus, 15000);
  setInterval(syncFromServer, 20000);
  // Polling is pointless while the tab is hidden, but a return deserves a refresh.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { refreshServerStatus(); syncFromServer(); } });
}

function registerPWA() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  navigator.serviceWorker.register("sw.js?v=6", { updateViaCache: "none" }).then((registration) => {
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          showToast("A new version of Quietweb is ready.", { label: "Reload", action: () => { installing.postMessage("skip-waiting"); location.reload(); } });
        }
      });
    });
  }).catch(() => {});
}

init().catch((error) => {
  $("pageList").innerHTML = `<div class="empty-state"><strong>Local storage is unavailable.</strong><span>${escapeHtml(error?.message || "Try serving this app from localhost or HTTPS, and check that private browsing is off.")}</span></div>`;
});
