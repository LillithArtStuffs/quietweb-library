#!/usr/bin/env sh
# Start Quietweb in a-Shell on iOS.
#
# This runs the server directly rather than through start.py, because iOS has
# no fork(): a-Shell emulates processes, so a server started as a subprocess
# does not reliably receive Ctrl+C and keeps holding the port. Running it as
# the only process means the interrupt goes straight to it.
#
# start.py's other jobs do not apply here anyway — there is no browser to hand
# off to, and the server already falls back to the next free port by itself.
set -eu
cd "$(dirname "$0")/.."

if command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON=python
else
  printf '%s\n' 'Python 3 is required in a-Shell.' >&2
  exit 1
fi

printf '%s\n' 'Starting Quietweb. Press Ctrl+C (the ^ key above the keyboard) to stop it.'
exec "$PYTHON" server/offline_server.py --host 0.0.0.0 "$@"
