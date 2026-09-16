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
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.QUIETWEB_PORT || 8799);
const TOKEN = "smoke-test-token-000000";
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
    "--allow-private-fetch"
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

    await check("the theme choice persists across reloads", async () => {
      await page.selectOption("#themeSelect", "teto");
      await page.reload({ waitUntil: "networkidle" });
      const theme = await page.getAttribute("html", "data-theme");
      if (theme !== "teto") throw new Error(`theme came back as ${theme}`);
      await page.selectOption("#themeSelect", "dark");
      return "teto survived a reload";
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
