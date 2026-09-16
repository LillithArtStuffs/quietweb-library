/**
 * Browser smoke test for Quietweb.
 *
 * Drives a real Chromium against a real server so the app can be verified from
 * a device that cannot open devtools. Requires Node and Playwright:
 *
 *     npm install playwright && npx playwright install chromium
 *     node scripts/browser/smoke.mjs
 *
 * Nothing else in the project depends on Node; this is a development aid.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.QUIETWEB_PORT || 8799);
const TOKEN = "smoke-test-token-000000";
const PASSPHRASE = "smoke-passphrase-000";
let BASE = "";

const results = [];
const consoleErrors = [];

async function check(name, action) {
  try {
    const detail = await action();
    results.push([true, name, detail || "ok"]);
  } catch (error) {
    results.push([false, name, error.message]);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A reload restores the last view from the hash, so tests say where they want
// to be instead of assuming the library is on screen.
// A check that is *supposed* to trigger network failures drops the console
// noise it caused, so the final clean-console check stays meaningful.
async function withExpectedNetworkErrors(action) {
  const start = consoleErrors.length;
  try { return await action(); } finally { consoleErrors.splice(start); }
}

// Rows and buttons animate their background, so a computed-style read taken
// straight after a theme switch returns a value mid-interpolation.
async function settleTransitions(page) {
  await wait(260);
}

async function goToLibrary(page) {
  await page.evaluate(() => { location.hash = "#library"; });
  await page.waitForSelector("#libraryView.active");
}

async function startServer() {
  const server = spawn(process.env.PYTHON || "python3", ["-u",
    join(ROOT, "server", "offline_server.py"),
    "--host", "127.0.0.1", "--port", String(PORT), "--admin-token", TOKEN,
    // The fixture site below lives on loopback, which the SSRF guard blocks by
    // default. selftest.py covers that guard; here we need the fetch to land.
    "--allow-private-fetch",
    // Run with the gate on, as a real server does, and unlock below.
    "--proxy-passphrase", PASSPHRASE
  ], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

  // The server falls back to the next free port, so take the URL it prints
  // rather than assuming the one we asked for.
  let banner = "";
  server.stdout.on("data", (chunk) => { banner += chunk.toString(); });
  server.stderr.on("data", () => {});

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const match = banner.match(/running at (http:\/\/\S+?)\/?\s/);
    if (match) {
      BASE = match[1].replace(/\/$/, "");
      try {
        const response = await fetch(`${BASE}/api/status`);
        if (response.ok) return server;
      } catch (error) { /* not accepting connections yet */ }
    }
    await wait(150);
  }
  server.kill();
  throw new Error(`the server never came up (output so far: ${banner.trim() || "none"})`);
}

// A tiny static site to archive, so the fetch path is exercised without
// depending on the public internet.
async function startFixtureSite() {
  const site = spawn(process.env.PYTHON || "python3", [
    "-u", "-m", "http.server", "0", "--bind", "127.0.0.1",
    "--directory", join(ROOT, "scripts", "browser", "fixture")
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let banner = "";
  site.stdout.on("data", (chunk) => { banner += chunk.toString(); });
  site.stderr.on("data", (chunk) => { banner += chunk.toString(); });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const match = banner.match(/port (\d+)/);
    if (match) return { site, url: `http://127.0.0.1:${match[1]}/article.html` };
    await wait(100);
  }
  site.kill();
  throw new Error("the fixture site never started");
}

async function main() {
  const server = await startServer();
  const { site, url: fixtureUrl } = await startFixtureSite();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  try {
    await page.goto(BASE, { waitUntil: "networkidle" });

    await check("a locked server challenges before it serves anything private", () => withExpectedNetworkErrors(async () => {
      const library = await page.evaluate(async () => {
        const response = await fetch("/api/library", { cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        return { status: response.status, unlock: body.unlock };
      });
      if (library.status !== 401) throw new Error(`/api/library returned ${library.status} while locked`);
      if (library.unlock !== "/p/login") throw new Error("the 401 does not say where to unlock");
      const proxy = await page.evaluate(async () => (await fetch("/p/", { redirect: "manual" })).status);
      if (proxy !== 401) throw new Error(`/p/ returned ${proxy} while locked`);
      // The shell still has to load, or it cannot tell you it is locked.
      await page.waitForSelector(".page-row");
      return "library and proxy refused, app shell still loads";
    }));

    await check("a locked server explains itself in the archiver", () => withExpectedNetworkErrors(async () => {
      await goToLibrary(page);
      await page.click('[data-view="add"]');
      await page.fill("#urlInput", fixtureUrl);
      await page.click("#fetchButton");
      await page.waitForFunction(
        () => /locked/i.test(document.getElementById("entryStatus").textContent),
        null, { timeout: 20000 });
      const status = await page.locator("#entryStatus").innerText();
      if (!/passphrase/i.test(status)) throw new Error(`unhelpful message: "${status}"`);
      await page.click("#clearFormButton");
      return "told to unlock rather than a parse error";
    }));

    await check("the passphrase unlocks it for the whole app", async () => {
      await page.goto(`${BASE}/p/login`, { waitUntil: "domcontentloaded" });
      await page.fill('input[name="passphrase"]', PASSPHRASE);
      await page.click("button");
      await page.waitForLoadState("networkidle");
      await page.goto(BASE, { waitUntil: "networkidle" });
      const library = await page.evaluate(async () => (await fetch("/api/library", { cache: "no-store" })).status);
      if (library !== 200) throw new Error(`/api/library still returns ${library} after unlocking`);
      consoleErrors.length = 0;  // Everything before the unlock was meant to fail.
      return "one login opens the library, the proxy and the archiver";
    });

    await check("the app boots with its seed pages", async () => {
      await page.waitForSelector(".page-row");
      const rows = await page.locator(".page-row").count();
      if (rows < 2) throw new Error(`expected the two seed pages, saw ${rows}`);
      return `${rows} rows`;
    });

    await check("the server is detected", async () => {
      await page.waitForSelector(".connection.online", { timeout: 5000 });
      return await page.locator("#connectionState").innerText();
    });

    await check("a note can be saved", async () => {
      await page.click('[data-view="add"]');
      await page.fill("#titleInput", "Smoke test note");
      await page.fill("#tagInput", "smoke");
      await page.selectOption("#typeInput", "note");
      await page.fill("#contentInput", "The quick brown fox jumps over the lazy dog.");
      await page.click("#saveEntryButton");
      await page.waitForSelector('.page-row h3:text-is("Smoke test note")');
      return "saved and listed";
    });

    await check("search narrows the list", async () => {
      await page.fill("#searchInput", "quick brown fox");
      await page.waitForFunction(() => document.querySelectorAll(".page-row").length === 1);
      await page.fill("#searchInput", "");
      await page.waitForFunction(() => document.querySelectorAll(".page-row").length > 1);
      return "matched exactly one page, then reset";
    });

    await check("pressing / focuses the search box", async () => {
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("/");
      const focused = await page.evaluate(() => document.activeElement?.id);
      if (focused !== "searchInput") throw new Error(`focus landed on ${focused}`);
      await page.keyboard.press("Escape");
      return "focus moved to the search box";
    });

    await check("a page opens in the reader", async () => {
      await page.click('.page-row:has(h3:text-is("Smoke test note"))');
      await page.waitForSelector("#readerView.active");
      const title = await page.locator("#readerTitle").innerText();
      if (title !== "Smoke test note") throw new Error(`reader shows "${title}"`);
      return "reader shows the right page";
    });

    await check("an existing page can be edited", async () => {
      await page.click('[data-reader-action="edit"]');
      await page.waitForSelector("#addView.active");
      await page.fill("#titleInput", "Smoke test note (edited)");
      await page.click("#saveEntryButton");
      await page.waitForSelector("#readerView.active");
      const title = await page.locator("#readerTitle").innerText();
      if (title !== "Smoke test note (edited)") throw new Error(`reader shows "${title}"`);
      const meta = await page.locator("#readerMeta").innerText();
      if (!meta.includes("edited")) throw new Error("the reader does not show an edited timestamp");
      return "title updated and marked as edited";
    });

    await check("delete is undoable", async () => {
      await page.click('[data-reader-action="delete"]');
      await page.waitForSelector("#libraryView.active");
      const afterDelete = await page.locator('.page-row h3:text-is("Smoke test note (edited)")').count();
      if (afterDelete !== 0) throw new Error("the page survived the delete");
      await page.click(".toast-action");
      await page.waitForSelector('.page-row h3:text-is("Smoke test note (edited)")');
      return "deleted, then restored from the toast";
    });

    await check("the library survives a reload", async () => {
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector('.page-row h3:text-is("Smoke test note (edited)")');
      return "IndexedDB kept the page";
    });

    await check("clicking a tag searches for it", async () => {
      await page.click('.page-row [data-tag="smoke"]');
      await page.waitForFunction(() => document.querySelectorAll(".page-row").length === 1);
      await page.fill("#searchInput", "");
      await page.waitForFunction(() => document.querySelectorAll(".page-row").length > 1);
      return "tag filtered to its own page";
    });

    await check("filters select by type", async () => {
      // Add a bookmark so the library holds more than one type to filter on.
      await goToLibrary(page);
      await page.click('[data-view="add"]');
      await page.fill("#titleInput", "Smoke test bookmark");
      await page.fill("#tagInput", "smoke");
      await page.selectOption("#typeInput", "bookmark");
      await page.fill("#urlInput", "https://example.com/smoke");
      await page.click("#saveEntryButton");
      await page.waitForSelector("#libraryView.active");

      await page.click("#filterButton");
      await page.click('[data-filter="bookmark"]');
      await page.waitForFunction(() => document.querySelectorAll(".page-row").length === 1);
      await page.click('[data-filter="note"]');
      const notes = await page.locator(".page-row").count();
      await page.click('[data-filter="all"]');
      const all = await page.locator(".page-row").count();
      await page.click("#filterButton");
      if (notes >= all) throw new Error(`note filter showed ${notes} of ${all} pages`);
      return `${notes} notes out of ${all} pages`;
    });

    await check("diagnostics report no failures", async () => {
      await page.click('.header-button[data-view="diagnostics"]');
      await page.click("#runTestsButton");
      await page.waitForSelector(".test-result");
      await page.waitForFunction(() => document.getElementById("diagnosticSummary").textContent.includes("passed"));
      const failures = await page.locator(".test-result.fail strong").allInnerTexts();
      if (failures.length) throw new Error(`failing checks: ${failures.join(", ")}`);
      return await page.locator("#diagnosticSummary").innerText();
    });

    await check("the console answers safe commands", async () => {
      await page.fill("#consoleInput", "status");
      await page.press("#consoleInput", "Enter");
      await page.waitForFunction(() => document.getElementById("consoleOutput").textContent.includes("server: connected"));
      await page.fill("#consoleInput", "tags");
      await page.press("#consoleInput", "Enter");
      await page.waitForFunction(() => document.getElementById("consoleOutput").textContent.includes("smoke"));
      return "status and tags responded";
    });

    const saveCode = async (title, source) => {
      await goToLibrary(page);
      await page.click('[data-view="add"]');
      await page.fill("#titleInput", title);
      await page.fill("#tagInput", "code");
      await page.selectOption("#typeInput", "code");
      await page.fill("#contentInput", source);
      await page.click("#saveEntryButton");
      await page.waitForSelector("#libraryView.active");
      await page.click(`.page-row:has(h3:text-is("${title}"))`);
      await page.waitForSelector("#readerView.active");
      return page.evaluate(() => {
        const texts = (name) => [...document.querySelectorAll(`#readerBody .syn-${name}`)].map((n) => n.textContent);
        return {
          language: document.querySelector("#readerMeta .code-language")?.textContent || "",
          comment: texts("comment"), string: texts("string"), number: texts("number"),
          keyword: texts("keyword"), builtin: texts("builtin"), function: texts("function"),
          body: document.querySelector("#readerBody").textContent,
          elements: [...document.querySelectorAll("#readerBody *")].map((n) => n.tagName)
        };
      });
    };

    await check("javascript is highlighted", async () => {
      const found = await saveCode("Smoke js", [
        "// count the things",
        "const total = 42;",
        "function greet(name) {",
        "  return `hello ${name}`;",
        "}"
      ].join("\n"));
      if (found.language !== "javascript") throw new Error(`detected as "${found.language}"`);
      if (!found.comment.some((t) => t.includes("count the things"))) throw new Error("comment not highlighted");
      for (const word of ["const", "function", "return"]) {
        if (!found.keyword.includes(word)) throw new Error(`"${word}" was not treated as a keyword`);
      }
      if (!found.number.includes("42")) throw new Error("number not highlighted");
      if (!found.function.includes("greet")) throw new Error("function name not highlighted");
      if (!found.string.some((t) => t.includes("hello"))) throw new Error("template literal not highlighted");
      return `${found.keyword.length} keywords, ${found.string.length} strings`;
    });

    await check("ren'py is detected and highlighted", async () => {
      const found = await saveCode("Smoke rpy", [
        "label start:",
        '    scene bg room',
        '    e "Hello there."',
        "    return"
      ].join("\n"));
      if (found.language !== "renpy") throw new Error(`detected as "${found.language}"`);
      for (const word of ["label", "scene", "return"]) {
        if (!found.keyword.includes(word)) throw new Error(`"${word}" was not treated as a keyword`);
      }
      if (!found.string.some((t) => t.includes("Hello there."))) throw new Error("dialogue string not highlighted");
      return "label, scene and dialogue recognised";
    });

    await check("highlighted source cannot become markup", async () => {
      const payload = '<img src=x onerror="alert(1)"> <script>alert(2)</scr' + 'ipt>';
      const found = await saveCode("Smoke xss", payload);
      if (found.elements.includes("IMG") || found.elements.includes("SCRIPT")) {
        throw new Error(`the payload became real elements: ${found.elements.join(", ")}`);
      }
      if (!found.body.includes("onerror")) throw new Error("the source text was lost");
      const stray = found.elements.filter((tag) => tag !== "SPAN");
      if (stray.length) throw new Error(`unexpected elements: ${stray.join(", ")}`);
      return "rendered as text in spans only";
    });

    await check("syntax colours follow the theme and stay legible", async () => {
      // Sample a page known to contain all the token kinds.
      await goToLibrary(page);
      await page.click('.page-row:has(h3:text-is("Smoke js"))');
      await page.waitForSelector("#readerBody .syn-comment");
      const palettes = new Set();
      const problems = [];
      for (const theme of ["light", "dark", "teto", "teto-dark", "wire"]) {
        await page.selectOption("#themeSelect", theme);
        await settleTransitions(page);
        const found = await page.evaluate(() => {
          const parse = (v) => (v.match(/[\d.]+/g) || []).map(Number);
          const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          const lum = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
          const back = parse(getComputedStyle(document.querySelector("#readerBody")).backgroundColor);
          const tokens = {};
          for (const name of ["comment", "string", "number", "keyword", "builtin", "function", "punct"]) {
            const node = document.querySelector(`#readerBody .syn-${name}`);
            if (!node) continue;
            const front = parse(getComputedStyle(node).color);
            const [hi, lo] = [lum(front), lum(back)].sort((a, b) => b - a);
            tokens[name] = { colour: getComputedStyle(node).color, ratio: (hi + 0.05) / (lo + 0.05) };
          }
          return { back: getComputedStyle(document.querySelector("#readerBody")).backgroundColor, tokens };
        });
        const names = Object.keys(found.tokens);
        if (names.length < 5) throw new Error(`${theme} painted only ${names.length} token kinds`);
        palettes.add(names.map((n) => found.tokens[n].colour).join("|"));
        // Every token must be readable on that theme's own code surface.
        names.forEach((name) => {
          if (found.tokens[name].ratio < 3) {
            problems.push(`${theme} .syn-${name} ${found.tokens[name].ratio.toFixed(2)}:1 on ${found.back}`);
          }
        });
      }
      if (problems.length) throw new Error(problems.join(", "));
      // Themes may share a syntax palette when they share a code surface, but
      // they must not all be the same, which would mean syntax ignores themes.
      if (palettes.size < 2) throw new Error("every theme paints syntax identically");
      return `${palettes.size} syntax palettes, all tokens above 3:1`;
    });

    await check("every theme repaints every surface", async () => {
      await goToLibrary(page);
      const signatures = {};
      for (const theme of ["light", "dark", "teto", "teto-dark", "wire"]) {
        await page.selectOption("#themeSelect", theme);
        await settleTransitions(page);
        signatures[theme] = await page.evaluate(() => {
          const paint = (selector, property) => {
            const node = document.querySelector(selector);
            return node ? getComputedStyle(node)[property] : "missing";
          };
          return [
            paint("body", "backgroundColor"),
            paint(".control-bar", "backgroundColor"),
            paint(".page-row", "backgroundColor"),
            paint(".console", "backgroundColor"),
            paint(".console pre", "color"),
            paint(".site-header", "backgroundColor"),
            paint(".button.subtle", "color")
          ].join(" | ");
        });
      }
      const seen = new Map();
      for (const [theme, signature] of Object.entries(signatures)) {
        if (seen.has(signature)) throw new Error(`${theme} paints identically to ${seen.get(signature)}`);
        seen.set(signature, theme);
      }
      return `${seen.size} distinct palettes`;
    });

    await check("no theme makes text unreadable", async () => {
      const problems = [];
      for (const theme of ["light", "dark", "teto", "teto-dark", "wire"]) {
        await page.selectOption("#themeSelect", theme);
        await settleTransitions(page);
        const found = await page.evaluate(() => {
          const parse = (value) => (value.match(/[\d.]+/g) || []).map(Number);
          const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
          const over = (top, bottom) => {
            const a = top.length > 3 ? top[3] : 1;
            return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a));
          };
          // Walk up for the first ancestor that actually paints something.
          const backdrop = (node) => {
            let layers = [];
            for (let el = node; el; el = el.parentElement) {
              const colour = parse(getComputedStyle(el).backgroundColor);
              if (colour.length && (colour.length < 4 || colour[3] > 0)) {
                layers.push(colour);
                if (colour.length < 4 || colour[3] === 1) break;
              }
            }
            return layers.reverse().reduce((base, layer) => over(layer, base), [255, 255, 255]);
          };
          const ratio = (selector) => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const front = over(parse(getComputedStyle(node).color), backdrop(node));
            const back = backdrop(node);
            const [bright, dark] = [luminance(front), luminance(back)].sort((a, b) => b - a);
            return { selector, value: (bright + 0.05) / (dark + 0.05) };
          };
          return [".lede", ".button.subtle", ".back-link", ".page-row h3", ".page-row p",
                  ".page-row-tag", ".brand small", ".console pre", ".console-head span",
                  ".button.accent", ".muted"]
            .map(ratio).filter(Boolean);
        });
        found.filter((entry) => entry.value < 3).forEach((entry) =>
          problems.push(`${theme} ${entry.selector} ${entry.value.toFixed(2)}:1`));
      }
      if (problems.length) throw new Error(problems.join(", "));
      return "every sampled pair clears 3:1";
    });

    await check("the theme choice persists across reloads", async () => {
      await page.selectOption("#themeSelect", "teto");
      await page.reload({ waitUntil: "networkidle" });
      const theme = await page.getAttribute("html", "data-theme");
      if (theme !== "teto") throw new Error(`theme came back as ${theme}`);
      await page.selectOption("#themeSelect", "dark");
      return "teto survived a reload";
    });

    await check("the theme editor edits live and saves", async () => {
      await goToLibrary(page);
      await page.click("#editThemeButton");
      await page.waitForSelector("#themesView.active");
      const rows = await page.locator(".token-row").count();
      if (rows !== 49) throw new Error(`the editor shows ${rows} tokens, expected 49`);

      await page.selectOption("#themeBase", "dark");
      await page.fill('[data-token="paper"]', "#2b0d12");
      await page.fill('[data-token="coral"]', "#e8102a");
      await settleTransitions(page);
      const live = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      if (live !== "rgb(43, 13, 18)") throw new Error(`the page did not repaint live, body is ${live}`);

      await page.fill("#themeName", "Smoke theme");
      await page.click("#saveThemeButton");
      await page.waitForFunction(() =>
        [...document.querySelectorAll("#themeSelect option")].some((o) => o.value === "custom:Smoke theme"));
      const picked = await page.inputValue("#themeSelect");
      if (picked !== "custom:Smoke theme") throw new Error(`the picker shows "${picked}" after saving`);
      return `${rows} tokens, saved and selected`;
    });

    await check("a custom theme survives a reload", async () => {
      await page.reload({ waitUntil: "networkidle" });
      const [preference, paper] = await page.evaluate(() => [
        localStorage.getItem("quietweb-theme"),
        getComputedStyle(document.body).backgroundColor
      ]);
      if (preference !== "custom:Smoke theme") throw new Error(`preference came back as "${preference}"`);
      if (paper !== "rgb(43, 13, 18)") throw new Error(`the custom paper did not survive, body is ${paper}`);
      return "preference and palette both restored";
    });

    await check("switching back to a built-in drops the custom values", async () => {
      await page.selectOption("#themeSelect", "dark");
      await settleTransitions(page);
      const [paper, inline] = await page.evaluate(() => [
        getComputedStyle(document.body).backgroundColor,
        document.documentElement.getAttribute("style") || ""
      ]);
      if (paper === "rgb(43, 13, 18)") throw new Error("the custom paper leaked into the dark theme");
      if (inline.includes("--paper")) throw new Error(`inline overrides were left behind: ${inline}`);
      return "custom tokens cleared";
    });

    await check("the editor reports unreadable palettes", async () => {
      await goToLibrary(page);
      await page.click("#editThemeButton");
      await page.waitForSelector("#themesView.active");
      await page.selectOption("#themeBase", "light");
      await page.waitForSelector(".contrast-chip");
      const healthy = await page.locator(".contrast-chip.fail").count();
      if (healthy) throw new Error("the light theme was reported as unreadable");
      // Body text the same colour as the page it sits on must be called out.
      await page.fill('[data-token="ink"]', "#f3f0e8");
      await page.waitForFunction(() => document.querySelectorAll(".contrast-chip.fail").length > 0);
      const failing = await page.locator(".contrast-chip.fail").first().innerText();
      if (!/body text/i.test(failing)) throw new Error(`flagged the wrong pair: ${failing}`);
      return `caught it: ${failing}`;
    });

    await check("a theme exports and its CSS is complete", async () => {
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.click("#exportThemeButton")
      ]);
      const name = download.suggestedFilename();
      if (!name.startsWith("quietweb-theme-")) throw new Error(`downloaded ${name}`);
      const payload = JSON.parse(await readFile(await download.path(), "utf8"));
      const exported = Object.keys(payload.tokens || {});
      if (exported.length !== 49) throw new Error(`the export carries ${exported.length} tokens`);
      if (!payload.base) throw new Error("the export does not record a base theme");
      return `${name} with ${exported.length} tokens`;
    });

    await check("a saved theme can be deleted and undone", async () => {
      await page.selectOption("#themeSelect", "custom:Smoke theme");
      await goToLibrary(page);
      await page.click("#editThemeButton");
      await page.waitForSelector("#themesView.active");
      await page.click("#deleteThemeButton");
      await page.waitForFunction(() =>
        ![...document.querySelectorAll("#themeSelect option")].some((o) => o.value === "custom:Smoke theme"));
      await page.click(".toast-action");
      await page.waitForFunction(() =>
        [...document.querySelectorAll("#themeSelect option")].some((o) => o.value === "custom:Smoke theme"));
      return "deleted, then restored from the toast";
    });

    await check("the library exports as JSON", async () => {
      await goToLibrary(page);
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.click("#exportButton")
      ]);
      const name = download.suggestedFilename();
      if (!name.endsWith(".json")) throw new Error(`downloaded ${name}`);
      return name;
    });

    await check("fetching a URL archives a readable snapshot", async () => {
      await goToLibrary(page);
      await page.click('[data-view="add"]');
      await page.fill("#urlInput", fixtureUrl);
      await page.click("#fetchButton");
      await page.waitForFunction(
        () => /^Ready \(/.test(document.getElementById("entryStatus").textContent),
        null, { timeout: 20000 });

      const title = await page.inputValue("#titleInput");
      if (title !== "A Fixture Article") throw new Error(`title autofilled as "${title}"`);
      const content = await page.inputValue("#contentInput");
      if (!content.includes("readable text of a page")) throw new Error("the article text was not extracted");
      if (/site navigation|footer boilerplate/.test(content)) throw new Error("chrome leaked into the readable text");
      if (!content.includes("\n")) throw new Error("block elements did not become separate lines");
      if (await page.inputValue("#typeInput") !== "snapshot") throw new Error("the type was not switched to snapshot");

      await page.fill("#tagInput", "fixture");
      await page.click("#saveEntryButton");
      await page.waitForSelector("#libraryView.active");
      await page.click('.page-row:has(h3:text-is("A Fixture Article"))');
      await page.waitForSelector("#readerBody iframe");
      const frame = page.frameLocator("#readerBody iframe");
      await frame.locator("h1").waitFor();
      const heading = await frame.locator("h1").innerText();
      if (heading !== "A Fixture Article") throw new Error(`the snapshot renders "${heading}"`);
      const scripts = await page.evaluate(() => {
        const html = document.querySelector("#readerBody iframe").srcdoc;
        return ["<script", "onload", "<iframe", "PWNED"].filter((needle) => html.includes(needle));
      });
      if (scripts.length) throw new Error(`the snapshot still contains: ${scripts.join(", ")}`);
      return "archived, sanitised, and rendered offline";
    });

    await check("fetching a blocked URL fails loudly instead of silently", () => withExpectedNetworkErrors(async () => {
      await goToLibrary(page);
      await page.click('[data-view="add"]');
      await page.fill("#urlInput", "http://127.0.0.1:1/");
      await page.click("#fetchButton");
      // Wait past the "fetching..." placeholder for the settled result.
      await page.waitForFunction(
        () => /could not archive|ready \(/i.test(document.getElementById("entryStatus").textContent),
        null, { timeout: 20000 });
      const status = await page.locator("#entryStatus").innerText();
      if (!/could not archive/i.test(status)) throw new Error(`status said "${status}"`);
      if (!/browsers block cross-site|refusing to fetch|connection refused|refused/i.test(status)) throw new Error(`the refusal does not say why: "${status}"`);
      return "explained the refusal";
    }));

    await check("no uncaught console errors", async () => {
      const real = consoleErrors.filter((text) => !/favicon/i.test(text));
      if (real.length) throw new Error(real.slice(0, 3).join(" | "));
      return "clean console";
    });
  } finally {
    await browser.close();
    server.kill();
    site.kill();
  }

  const width = Math.max(...results.map(([, name]) => name.length));
  results.forEach(([passed, name, detail]) => console.log(`${passed ? "PASS" : "FAIL"}  ${name.padEnd(width)}  ${detail}`));
  const failed = results.filter(([passed]) => !passed);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
