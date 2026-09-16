# Quietweb Library

Quietweb is a browser-first, local web library for saving pages, notes, source code, and offline HTML snapshots. Nothing leaves your devices.

## Start the app

Use the launcher for your operating system:

- Windows: `scripts/start-offline-library.bat`
- macOS: `scripts/start-offline-library.command`
- Linux: `scripts/start-offline-library.sh`
- a-Shell on iOS: `scripts/start-ashell.sh`

Each launcher runs `scripts/start.py`, starts the local server in trusted-LAN mode, and opens the app. The terminal prints the network URL for other devices on the same Wi-Fi. If the port is busy the next free one is used, and the URL that is printed and opened is the real one.

Useful flags, which all launchers pass through:

```text
--local              bind to 127.0.0.1 only, so no other device can connect
--port 9000          start from a specific port
--no-browser         do not open a browser window
--allow-private-fetch  permit archiving LAN and localhost addresses (off by default)
```

### a-Shell on iOS

Copy the project folder into a-Shell, then run:

```sh
cd quietweb-library/scripts
sh start-ashell.sh
```

The terminal prints the iPhone's LAN URL. Keep a-Shell running, connect the other device to the same Wi-Fi, and open that URL in its browser. The iPhone hosts the app; the other device views it.

The viewing device must use the printed `http://192.168.x.x:8765/` address, not `127.0.0.1`. Both devices must be on the same Wi-Fi, and the host firewall must allow Python on private networks. Do not expose this server to the public internet. The in-app console is limited to Quietweb commands and never executes shell commands.

## Why the server matters

Browsers refuse to read pages from other sites, so **"Fetch URL content" only works while the Quietweb server is running** — the Python helper does the fetching and hands back a sanitised snapshot. Without it you can still write notes, import files, read, search, and export; you just cannot archive a live URL. The app says so plainly instead of failing quietly.

In LAN mode anyone on the same Wi-Fi can reach the fetch endpoint, so it refuses private and loopback targets unless you pass `--allow-private-fetch`.

## Sharing a library between devices

The host server owns the shared library at `server_data/library.json`. Enter the admin token (printed at startup) in **Diagnostics**, and saved pages sync to the host while connected browsers poll for updates. Syncing **merges** rather than overwrites: the most recently updated copy of each page wins, and pages you delete stay deleted. `server_data/` is gitignored, so personal pages are never published.

## Themes

Four themes ship: **Light**, **Dark**, **Teto SV**, and **Nightwire**. **System** follows the OS light/dark setting and keeps following it if the OS flips while the app is open. The choice is remembered per device, and `theme <name>` works in the console.

Every colour the app paints comes from a custom property — 49 tokens, including a full syntax palette. A theme is one block of tokens in `web/styles.css` and nothing else; there are no per-theme rules anywhere in the stylesheet.

### The theme editor

**Theme editor** in the header (or press `t`) opens a live editor for all 49 tokens, grouped by what they affect. Typing a colour repaints the whole app immediately, so you are always looking at the real thing rather than a swatch.

- **Start from** any built-in theme, then change what you want.
- **Readability** chips across the top show the contrast ratio for the pairs that matter — body text, header text, code, syntax. Under 4.5:1 warns, under 3:1 fails, so a theme cannot quietly become unreadable.
- **Save** puts it in the picker under *Yours*. Saved themes persist on the device and are chosen like any built-in.
- **Export** / **Import** move a theme between devices as JSON. An import takes any token the file omits from its base theme.
- **Copy CSS** produces a finished `html[data-theme="..."]` block. Paste it into `web/styles.css`, add the name to `THEMES` and `THEME_COLORS` in `web/app.js` and an `<option>` to `#themeSelect`, and it becomes a built-in.
- **Delete** is undoable from the toast.

Leaving the editor without saving reverts the preview.

`scripts/selftest.py` fails the build if a theme leaves any token undefined, if the editor cannot reach a token the stylesheet declares (or offers one it does not), if the picker and `app.js` disagree, or if any colour gets hardcoded outside a theme block. The browser suite checks that each theme repaints every surface, that syntax colours change with it, that a saved theme survives a reload, that switching back to a built-in drops the custom values, and that no theme drops a sampled text/background pair below 3:1.

## Syntax highlighting

Pages saved as **Code** are highlighted in the reader, themed from the same tokens as everything else. JavaScript, Python, **Ren'Py**, HTML, CSS, and JSON are recognised.

The language comes from the page's extension when a file is imported, and is otherwise detected from the content — so pasting a Ren'Py script into a page tagged `code` is enough. The detected language shows as a badge next to the reader's metadata.

There are no dependencies and no build step: the highlighter is a small tokenizer in `web/app.js` that emits DOM nodes rather than markup, so highlighted source can never turn into HTML. Files over 200 KB render as plain text instead. To add a language, add a grammar to `GRAMMARS` (and keywords to `KEYWORDS`/`BUILTINS`); the self-test fails if a grammar emits a token class the stylesheet does not style.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `/` | Focus the search box |
| `n` | New entry |
| `e` | Edit the page open in the reader |
| `d` | Diagnostics |
| `Esc` | Back to the library |
| `?` | Toggle the shortcut panel |

## Built-in diagnostics

Open **Diagnostics** to check IndexedDB storage, storage headroom, the service worker, the install manifest, file import APIs, whether URL archiving is available, and the page's security context. Checks report **pass**, **warning**, or **fail** — a LAN address is a warning, not a failure, because that is a supported way to run Quietweb.

## Built-in console

The Diagnostics view includes a safe app console: `help`, `status`, `pages`, `tags`, `tests`, `sync`, `export`, `theme <name>`, `find <text>`, `clear`, and `version`. It reads app state and never runs shell commands.

## Testing without a browser

```sh
python scripts/selftest.py
```

Boots the real server on a throwaway port against a temporary data directory and checks every endpoint, the admin token, the SSRF guard, snapshot sanitising, the manifest and icons, and that every element `app.js` looks up actually exists in `index.html`. No browser or network needed.

For a real browser run (optional, needs Node):

```sh
npm install playwright && npx playwright install chromium
node scripts/browser/smoke.mjs
```

This drives Chromium through saving, searching, editing, deleting and undoing, archiving a fixture page, exporting, and the diagnostics panel. Both suites run in CI on every push.

## Folders

- `web/`: browser application, styles, PWA manifest, icons, and service worker
- `server/`: local server and authorised fetch helper
- `scripts/`: cross-platform launchers, the icon generator, and the test suites
- `legacy/`: previous single-file prototype

Python 3 is required only for the launcher and server. The web app is plain browser APIs and can also be deployed as static files from `web/` — without the server, URL archiving is unavailable.
