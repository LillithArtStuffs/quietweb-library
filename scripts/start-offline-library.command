#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
  exec python3 start.py "$@"
elif command -v python >/dev/null 2>&1; then
  exec python start.py "$@"
else
  printf '%s\n' 'Python 3 is required. Install it from https://www.python.org/downloads/' >&2
  read -r _
  exit 1
fi
