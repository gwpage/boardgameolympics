#!/usr/bin/env bash
#
# tests/run.sh: run the browser test suite headlessly (ADR-001).
#
# Serves the repo root with Python's built-in static server, loads
# tests/index.html in headless Chrome, prints the report, and exits non-zero if
# any test failed or the page never finished. No npm, no Node.
#
# Usage (from anywhere):
#   tests/run.sh
#   CHROME_BIN="/path/to/chrome" tests/run.sh    # non-default Chrome location
#   TEST_PORT=8123 tests/run.sh                  # fixed port instead of a free one
#
# Exit codes: 0 = all passed, 1 = failures or page never finished, 2 = setup problem.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DEFAULT_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
readonly CHROME="${CHROME_BIN:-$DEFAULT_CHROME}"
readonly HOST="127.0.0.1"
# Chrome fast-forwards timers in virtual time. This caps how much virtual time the
# page may use before the DOM is dumped. Generous, because a dump taken too early
# shows "running" and is reported as a failure, not a pass.
readonly VIRTUAL_TIME_BUDGET_MS=60000
# How long to wait for the static server to start accepting connections.
readonly SERVER_START_ATTEMPTS=50
readonly SERVER_START_INTERVAL_S=0.1

EXIT_SETUP_PROBLEM=2

if [[ ! -x "$CHROME" ]]; then
  echo "Chrome not found at: $CHROME" >&2
  echo "Install Google Chrome or set CHROME_BIN to its executable." >&2
  exit "$EXIT_SETUP_PROBLEM"
fi

# Ask the OS for a free port unless one was given, so parallel runs don't collide.
PORT="${TEST_PORT:-$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')}"
readonly PORT
readonly TEST_URL="http://$HOST:$PORT/tests/"

# Throwaway Chrome profile, so this never touches (or locks) the user's real profile.
WORK_DIR="$(mktemp -d)"
readonly WORK_DIR
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    # Reap the server so bash doesn't print a "Terminated" job notice.
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

python3 -I -m http.server "$PORT" --bind "$HOST" --directory "$REPO_ROOT" >"$WORK_DIR/server.log" 2>&1 &
SERVER_PID=$!

server_ready=false
for _ in $(seq 1 "$SERVER_START_ATTEMPTS"); do
  if curl -fsS -o /dev/null "$TEST_URL" 2>/dev/null; then
    server_ready=true
    break
  fi
  sleep "$SERVER_START_INTERVAL_S"
done
if [[ "$server_ready" != true ]]; then
  echo "Static server did not start on $TEST_URL" >&2
  cat "$WORK_DIR/server.log" >&2
  exit "$EXIT_SETUP_PROBLEM"
fi

if ! "$CHROME" \
  --headless \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions \
  --user-data-dir="$WORK_DIR/profile" \
  --virtual-time-budget="$VIRTUAL_TIME_BUDGET_MS" \
  --dump-dom "$TEST_URL" >"$WORK_DIR/dom.html" 2>"$WORK_DIR/chrome.log"; then
  echo "Headless Chrome exited with an error:" >&2
  tail -n 20 "$WORK_DIR/chrome.log" >&2
  exit "$EXIT_SETUP_PROBLEM"
fi

# Pull #summary (and its data-status) and #report out of the dumped DOM.
# html.parser is Python standard library; it also decodes &lt; &amp; etc.
set +e
python3 -I - "$WORK_DIR/dom.html" <<'PY'
import sys
from html.parser import HTMLParser

CAPTURED_IDS = ("summary", "report")

class ReportExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.capturing = None
        self.text = {element_id: "" for element_id in CAPTURED_IDS}
        self.status = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        element_id = attributes.get("id")
        if tag == "pre" and element_id in CAPTURED_IDS:
            self.capturing = element_id
            if element_id == "summary":
                self.status = attributes.get("data-status")

    def handle_endtag(self, tag):
        if tag == "pre":
            self.capturing = None

    def handle_data(self, data):
        if self.capturing:
            self.text[self.capturing] += data

with open(sys.argv[1], encoding="utf-8") as dom_file:
    extractor = ReportExtractor()
    extractor.feed(dom_file.read())

if extractor.text["report"].strip():
    print(extractor.text["report"].rstrip())
    print()

# Everything goes to stdout so the summary always prints after the report;
# the exit code carries pass/fail.
if extractor.status in ("pass", "fail"):
    print(extractor.text["summary"].strip())
    sys.exit(0 if extractor.status == "pass" else 1)

print(
    f"FAIL: test page never finished (status: {extractor.status!r}). "
    "A syntax error in tests/harness.js or tests/index.html, or a test that "
    "outran the virtual time budget, can cause this."
)
sys.exit(1)
PY
result=$?
set -e

if [[ "$result" -ne 0 ]]; then
  # Missing files are the most common cause of load failures; show them.
  # (Some tests request a file on purpose to prove it's gone, so a 404 here
  # isn't automatically a problem.)
  if grep -q '" 404 ' "$WORK_DIR/server.log"; then
    echo ""
    echo "Files requested but not found (HTTP 404):"
    grep '" 404 ' "$WORK_DIR/server.log" | sed -E 's/.*"(GET [^"]*)".*/  \1/' | sort -u
  fi
fi

exit "$result"
