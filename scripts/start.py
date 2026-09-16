"""Start Quietweb on any desktop OS and open it in the default browser.

    python start.py                 # trusted-LAN mode (other devices can connect)
    python start.py --local         # loopback only
    python start.py --port 9000     # pick a port
    python start.py --no-browser    # do not open a browser window
"""

from pathlib import Path
import shutil
import socket
import subprocess
import sys
import webbrowser

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server" / "offline_server.py"
DEFAULT_PORT = 8765
PORT_ATTEMPTS = 8


def find_python():
    candidates = [sys.executable, shutil.which("python3"), shutil.which("python"), shutil.which("py")]
    return next((candidate for candidate in candidates if candidate), None)


def take_option(arguments, name, default=None):
    """Pull "--name value" out of the argument list and return the value."""
    if name not in arguments:
        return default, arguments
    index = arguments.index(name)
    if index + 1 >= len(arguments):
        raise SystemExit(f"{name} needs a value.")
    value = arguments[index + 1]
    return value, arguments[:index] + arguments[index + 2:]


def first_free_port(host, port):
    """Find a port the server will actually be able to bind."""
    for offset in range(PORT_ATTEMPTS):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((host, port + offset))
                return port + offset
            except OSError:
                continue
    return port


def main():
    arguments = sys.argv[1:]
    if not SERVER.exists():
        print(f"Cannot find the server at {SERVER}. Run this script from inside the project folder.")
        return 1

    open_browser = "--no-browser" not in arguments
    arguments = [argument for argument in arguments if argument != "--no-browser"]
    local_only = "--local" in arguments
    arguments = [argument for argument in arguments if argument != "--local"]

    host, arguments = take_option(arguments, "--host", "127.0.0.1" if local_only else "0.0.0.0")
    port_text, arguments = take_option(arguments, "--port", str(DEFAULT_PORT))
    try:
        port = int(port_text)
    except ValueError:
        raise SystemExit("--port must be a number.")

    python = find_python()
    if not python:
        print("Python 3 is required. Install it from https://www.python.org/downloads/")
        return 1

    # Resolve the port here so the URL printed and opened is the real one.
    port = first_free_port("127.0.0.1" if host in {"0.0.0.0", "::"} else host, port)
    command = [python, str(SERVER), "--host", host, "--port", str(port), *arguments]
    process = subprocess.Popen(command, cwd=ROOT)

    url = f"http://{'127.0.0.1' if host in {'0.0.0.0', '::'} else host}:{port}/"
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass  # a-Shell and other sandboxes have no browser to hand off to.
    print(f"Quietweb is running at {url}")
    if host in {"0.0.0.0", "::"}:
        print("Other devices on the same Wi-Fi can reach it. Pass --local to keep it on this machine only.")
    print("Close this window or press Ctrl+C to stop it.")

    try:
        return process.wait()
    except KeyboardInterrupt:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
