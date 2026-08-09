#!/bin/bash
# Double-click this file in Finder to run CannaMap properly.
#
# The app cannot be opened as a plain file: browsers block fetch() on file://
# URLs, so data/shops.json never loads, and service workers (the PWA/offline
# part) only register over http://localhost or HTTPS. This starts the local
# server and opens the right URL.

cd "$(dirname "$0")" || exit 1

PORT=8000
URL="http://localhost:$PORT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed or not on PATH."
  echo "Install it from https://nodejs.org, then double-click this again."
  read -r -p "Press Return to close..."
  exit 1
fi

# If something is already serving on the port, just open the browser.
if curl -s -o /dev/null --max-time 2 "$URL"; then
  echo "Server already running at $URL"
  open "$URL"
  exit 0
fi

echo "Starting CannaMap at $URL"
echo "Leave this window open while you use the app. Press Ctrl+C to stop."
echo

node tools/serve.js "$PORT" &
SERVER_PID=$!

# Give the server a moment, then open the browser.
sleep 1
open "$URL"

trap 'kill $SERVER_PID 2>/dev/null' EXIT
wait $SERVER_PID
