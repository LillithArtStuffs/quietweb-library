"""Start Quietweb on any desktop OS and open it in the default browser."""

from pathlib import Path
import shutil
import subprocess
import sys
import webbrowser

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server" / "offline_server.py"
URL = "http://127.0.0.1:8765/"


def find_python():
    candidates = [sys.executable, shutil.which("python3"), shutil.which("python"), shutil.which("py")]
    return next((candidate for candidate in candidates if candidate), None)


def main():
    arguments = sys.argv[1:]
    if "--host" not in arguments:
        arguments = ["--host", "0.0.0.0", *arguments]
    python = find_python()
    if not python:
        print("Python 3 is required. Install it from https://www.python.org/downloads/")
        return 1
    process = subprocess.Popen([python, str(SERVER), *arguments], cwd=ROOT)
    host = "127.0.0.1"
    port = "8765"
    if "--host" in arguments:
        host = arguments[arguments.index("--host") + 1]
    if "--port" in arguments:
        port = arguments[arguments.index("--port") + 1]
    open_host = "127.0.0.1" if host == "0.0.0.0" else host
    url = f"http://{open_host}:{port}/"
    webbrowser.open(url)
    print(f"Quietweb is running at {url}")
    print("Close this window or press Ctrl+C to stop it.")
    try:
        process.wait()
    except KeyboardInterrupt:
        process.terminate()
        process.wait()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
