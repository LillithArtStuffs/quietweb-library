"""Publishing the local server on the public internet with Tailscale Funnel.

A tailnet address only works on devices that can run Tailscale. Funnel is the
way round that: it hands out an ordinary `https://<name>.ts.net` address that
any browser can open, which is the only thing that helps on a machine you do
not control — a managed school laptop, a borrowed desktop.

That is also precisely what makes it dangerous. The same address is open to
everyone else on the internet, and scanners find new ts.net names quickly. So
nothing here starts a funnel until the passphrase gate is on and the passphrase
is one that has not been published somewhere anyone can read it.

The tailscale CLI is reached through an injected runner so the rules above can
be tested without Tailscale installed and without spawning anything.
"""

from pathlib import Path
import json
import re
import shutil

# Funnel puts this on the open internet, so it asks for more than MIN_SECRET.
MIN_PUBLIC_SECRET = 16
# Every passphrase this project has ever printed in its own documentation or
# suggested in conversation. A funnel address is public the moment it exists.
PUBLISHED = {"quietweb", "quietweb-open-up", "teto-drill-red", "changeme",
             "password", "passphrase", "letmein", "quietweb-library"}
# Where a passphrase would be if someone pasted it into the project by mistake.
READABLE_FILES = ("README.md", "scripts/start-ashell.sh", "scripts/start-offline-library.sh",
                  "scripts/start-offline-library.bat", "scripts/start-offline-library.command")
# Windows and the macOS app bundle keep the CLI off PATH.
BINARIES = ("tailscale",
            r"C:\Program Files\Tailscale\tailscale.exe",
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "/usr/local/bin/tailscale")
COMMAND_TIMEOUT = 30
ADDRESS = re.compile(r"https://[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net/?", re.I)


class FunnelError(Exception):
    """Funnel could not be started, with a reason worth showing the user."""


def published_in(passphrase, root):
    """The project file this passphrase is written in, if any."""
    for name in READABLE_FILES:
        path = Path(root) / name
        try:
            if passphrase in path.read_text(encoding="utf-8", errors="replace"):
                return name
        except OSError:
            continue
    return ""


def refuse(passphrase, gate_enabled, root):
    """Why this passphrase must not go on the public internet, or "" if it may.

    Length is not the whole story here: the example passphrases are long enough
    to satisfy MIN_PUBLIC_SECRET and still the first thing anyone would try.
    """
    if not gate_enabled:
        return ("--funnel with --no-proxy-auth would publish an open proxy to the entire\n"
                "internet, which is the one thing this server must never be. Refusing.")
    if len(passphrase) < MIN_PUBLIC_SECRET:
        return (f"--funnel needs a passphrase of at least {MIN_PUBLIC_SECRET} characters; "
                f"this one is {len(passphrase)}.\nThe address it creates is public, so the "
                "passphrase is the whole defence.")
    if passphrase.lower() in PUBLISHED:
        return ("That passphrase is one of this project's own examples, so it is the first\n"
                "thing anyone would try. Pick one that has never been written down.")
    where = published_in(passphrase, root)
    if where:
        return (f"That passphrase is written in {where}, so anyone who can read this\n"
                "project already has it. Pick another.")
    return ""


def run_command(arguments):
    """Run the tailscale CLI and return (code, stdout, stderr)."""
    import subprocess  # Imported here so importing this module never needs fork().
    try:
        done = subprocess.run(arguments, capture_output=True, text=True, timeout=COMMAND_TIMEOUT)
    except OSError as error:
        # iOS has no fork(), and a-Shell has no tailscale to run either way.
        raise FunnelError(f"Could not run {arguments[0]}: {error}")
    except Exception as error:  # A timeout is the realistic one.
        raise FunnelError(f"{arguments[0]} did not finish: {error}")
    return done.returncode, done.stdout, done.stderr


class Funnel:
    """A funnel this process started, and is therefore responsible for stopping."""

    def __init__(self, run=run_command, binary=None):
        self.run = run
        self.binary = binary
        self.serving = False

    def locate(self):
        """The tailscale CLI, or a FunnelError explaining that it is missing."""
        if self.binary:
            return self.binary
        for candidate in BINARIES:
            # A bare name is looked up on PATH; a full path is simply checked.
            # Both separators, because the Windows path is a candidate on Linux
            # too and must not be handed to which().
            if "/" in candidate or "\\" in candidate:
                found = candidate if Path(candidate).exists() else ""
            else:
                found = shutil.which(candidate) or ""
            if found:
                self.binary = found
                return found
        raise FunnelError("Tailscale is not installed, or its command-line tool is not on PATH.\n"
                          "Install it from https://tailscale.com/download and sign in first.")

    def address(self):
        """This machine's public ts.net name, from the daemon rather than a guess."""
        code, out, error = self.run([self.locate(), "status", "--json"])
        if code != 0:
            raise FunnelError(f"tailscale status failed: {(error or out).strip()}")
        try:
            name = json.loads(out).get("Self", {}).get("DNSName", "")
        except ValueError:
            raise FunnelError("tailscale status did not return JSON this version understands.")
        if not name:
            raise FunnelError("This machine has no MagicDNS name, so Funnel has no address to "
                              "serve.\nEnable MagicDNS and HTTPS in the Tailscale admin console.")
        return name.rstrip(".")

    def start(self, port):
        """Publish http://127.0.0.1:<port> and return the public address."""
        code, out, error = self.run([self.locate(), "funnel", "--bg", str(port)])
        if code != 0:
            # Tailscale's own refusals are more useful than anything worth
            # inventing here: they name the setting and link the page to fix it.
            raise FunnelError((error or out).strip() or "tailscale funnel refused to start.")
        self.serving = True
        found = ADDRESS.search(out or "")
        return found.group(0).rstrip("/") if found else f"https://{self.address()}"

    def stop(self):
        """Take the funnel down. Safe to call twice, and never raises.

        This matters more than starting it: a funnel left running outlives the
        process and keeps a public address pointed at whatever takes the port
        next.
        """
        if not self.serving:
            return True
        self.serving = False
        try:
            code, _, _ = self.run([self.locate(), "funnel", "--https=443", "off"])
            return code == 0
        except FunnelError:
            return False
