# Quietweb Library

Quietweb is a browser-first, local web library for saving pages, notes, source code, and offline HTML snapshots.

## Start the app

Use the launcher for your operating system:

- Windows: `scripts/start-offline-library.bat`
- macOS: `scripts/start-offline-library.command`
- Linux: `scripts/start-offline-library.sh`
- a-Shell on iOS: `scripts/start-ashell.sh`

Each launcher uses `scripts/start.py`, starts the local server in trusted-LAN mode, and opens the app locally. The terminal also prints the network URL for other devices on the same Wi-Fi.

### a-Shell on iOS

Copy the project folder into a-Shell, then run:

```sh
cd VSC/scripts
sh start-ashell.sh
```

The terminal prints the iPhone's LAN URL. Keep a-Shell running, connect the Chromebook to the same Wi-Fi, and open that URL in its browser. The iPhone hosts the app; the Chromebook views it.

For a localhost-only session, explicitly bind to loopback:

```text
scripts/start-offline-library.bat --host 127.0.0.1
```

The other device must use the printed `http://192.168.x.x:8765/` address, not `127.0.0.1`. Both devices must be on the same Wi-Fi, and the host firewall must allow Python on private networks. Do not expose this server to the public internet. The in-app console is intentionally limited to Quietweb commands and does not execute arbitrary shell commands.

When the server starts, it prints an admin token. Open **Diagnostics** in Quietweb to see uptime, Python runtime, port, and connection state. Enter that token and an announcement to broadcast a message to connected viewers. Announcements are held in server memory and disappear when the server stops.

The host server also owns the shared library at `server_data/library.json`. Once the admin token is entered in Diagnostics, saved pages sync to the host and connected browsers poll for updates. The data directory is ignored by Git so personal pages are not published to GitHub.

Python 3 is required only for the local launcher/server. The web app itself is built from standard browser APIs and can also be deployed as static files from `web/`.

## Built-in diagnostics

Open **Diagnostics** in the app to check:

- IndexedDB read/write storage
- Service worker support
- PWA manifest availability
- File import APIs
- Localhost/HTTPS app context

## Folders

- `web/`: browser application, styles, PWA manifest, and service worker
- `server/`: optional localhost server and authorized fetch helper
- `scripts/`: cross-platform launchers
- `legacy/`: previous single-file prototype

## Built-in console

The Diagnostics view includes a safe app console with `help`, `status`, `tests`, `clear`, and `theme` commands. It is for app state and diagnostics, not remote command execution.
