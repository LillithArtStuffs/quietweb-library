#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
  exec python3 start.py --host 0.0.0.0 "$@"
elif command -v python >/dev/null 2>&1; then
  exec python start.py --host 0.0.0.0 "$@"
else
  printf '%s\n' 'Python 3 is required in a-Shell.' >&2
  exit 1
fi
