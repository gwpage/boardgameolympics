#!/usr/bin/env bash
#
# tests/run.sh: run the browser test suite headlessly (ADR-001).
#
# 1. Starts tests/server.py (Python stdlib) serving the repo root.
# 2. Opens /tests/?report in headless Chrome, using a throwaway profile.
# 3. Waits, in real time, for the page to POST its results back.
# 4. Prints the report.
# 5. Repeats steps 2-4 in two more time zones, UTC+14 and UTC-12 (ADR-022).
#    Those runs print only failures and the summary.
# Exits non-zero if anything failed in any zone.
# No npm, no Node. Needs python3 and Google Chrome.
#
# Usage (from anywhere):
#   tests/run.sh
#   CHROME_BIN="/path/to/chrome" tests/run.sh    # non-default Chrome location
#   TEST_TIMEOUT_S=300 tests/run.sh              # allow a slower run
#
# Exit codes: 0 = all passed, 1 = failures / crash / timeout, 2 = setup problem.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DEFAULT_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
readonly CHROME="${CHROME_BIN:-$DEFAULT_CHROME}"
readonly HOST="127.0.0.1"
# Upper bound for one run of the suite. Each test also has its own 5 s timeout in the harness.
readonly TEST_TIMEOUT_S="${TEST_TIMEOUT_S:-120}"
readonly POLL_INTERVAL_S=0.2
readonly SERVER_START_TIMEOUT_S=10
readonly EXIT_FAILED=1
readonly EXIT_SETUP_PROBLEM=2
# One run per entry. "" is the machine's own zone. The other two are the
# extremes, so date code that leans on the local zone gets a day wrong in at
# least one of them (ADR-022). Etc/GMT+12 really is UTC-12: these POSIX-style
# names flip the sign.
readonly TIME_ZONES=("" "Pacific/Kiritimati" "Etc/GMT+12")

if [[ ! -x "$CHROME" ]]; then
  echo "Chrome not found at: $CHROME" >&2
  echo "Install Google Chrome or set CHROME_BIN to its executable." >&2
  exit "$EXIT_SETUP_PROBLEM"
fi

WORK_DIR="$(mktemp -d)"
readonly WORK_DIR
readonly PORT_FILE="$WORK_DIR/port"
readonly REPORT_FILE="$WORK_DIR/report.json"
SERVER_PID=""
CHROME_PID=""

stop_process() {
  local pid="$1"
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null || true
    # Reap it, so bash doesn't print a "Terminated" job notice.
    wait "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  stop_process "$CHROME_PID"
  stop_process "$SERVER_PID"
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# Polls until a file exists, a deadline passes, or a watched process dies.
# Usage: wait_for_file <file> <timeout seconds> <pid to watch>
wait_for_file() {
  local file="$1" timeout_s="$2" pid="$3"
  local deadline=$((SECONDS + timeout_s))
  while [[ ! -f "$file" ]]; do
    if (( SECONDS >= deadline )); then
      return 1
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    sleep "$POLL_INTERVAL_S"
  done
}

python3 -I "$REPO_ROOT/tests/server.py" \
  --directory "$REPO_ROOT" \
  --bind "$HOST" \
  --port-file "$PORT_FILE" \
  --report-file "$REPORT_FILE" \
  >"$WORK_DIR/server.log" 2>&1 &
SERVER_PID=$!

if ! wait_for_file "$PORT_FILE" "$SERVER_START_TIMEOUT_S" "$SERVER_PID"; then
  echo "Test server did not start:" >&2
  cat "$WORK_DIR/server.log" >&2
  exit "$EXIT_SETUP_PROBLEM"
fi
readonly BASE_URL="http://$HOST:$(cat "$PORT_FILE")/tests/?report"

# Runs the suite once in headless Chrome and prints its report.
# Usage: run_suite <run number> <time zone, or "" for the machine's own>
# The first run prints every test; later runs print only failures. Every run
# prints its summary and the zone the page says it ran in. Returns 0 on a pass.
run_suite() {
  local run="$1" zone="$2"
  local url="$BASE_URL"
  if [[ -n "$zone" ]]; then
    # A '+' in a query string arrives as a space unless it's escaped.
    url+="&tz=${zone//+/%2B}"
  fi
  local show="failures"
  if [[ "$run" -eq 1 ]]; then
    show="all"
  fi

  rm -f "$REPORT_FILE"
  # Throwaway profile, so this never touches (or locks) the user's real Chrome
  # profile. ${zone:+...} sets TZ only when a zone is given.
  env ${zone:+"TZ=$zone"} "$CHROME" \
    --headless \
    --disable-gpu \
    --no-first-run \
    --no-default-browser-check \
    --disable-extensions \
    --user-data-dir="$WORK_DIR/profile-$run" \
    "$url" >"$WORK_DIR/chrome-$run.log" 2>&1 &
  CHROME_PID=$!

  if ! wait_for_file "$REPORT_FILE" "$TEST_TIMEOUT_S" "$CHROME_PID"; then
    if kill -0 "$CHROME_PID" 2>/dev/null; then
      echo "FAIL: no test report after ${TEST_TIMEOUT_S}s (time zone: ${zone:-this machine's}). A test may be hanging; open http://localhost:8000/tests/ in a browser to see where it stops."
    else
      echo "FAIL: headless Chrome exited before reporting (time zone: ${zone:-this machine's}):"
      tail -n 20 "$WORK_DIR/chrome-$run.log"
    fi
    stop_process "$CHROME_PID"
    CHROME_PID=""
    return "$EXIT_FAILED"
  fi
  stop_process "$CHROME_PID"
  CHROME_PID=""

  # Print the report the page posted: {status, summary, lines: [{ok, text}], timeZone}.
  python3 -I - "$REPORT_FILE" "$show" <<'PY'
import json
import sys

report_path, show = sys.argv[1], sys.argv[2]
with open(report_path, encoding="utf-8") as report_file:
    report = json.load(report_file)

shown = [line for line in report.get("lines", []) if show == "all" or not line["ok"]]
for line in shown:
    print(line["text"])
if shown:
    print()
summary = report.get("summary", "FAIL: report had no summary")
print(f"{summary} [time zone: {report.get('timeZone', 'unknown')}]")
sys.exit(0 if report.get("status") == "pass" else 1)
PY
}

result=0
run=0
for zone in "${TIME_ZONES[@]}"; do
  run=$((run + 1))
  if ! run_suite "$run" "$zone"; then
    result="$EXIT_FAILED"
  fi
done

if [[ "$result" -ne 0 ]] && grep -q '" 404 ' "$WORK_DIR/server.log"; then
  # Missing files are the most common cause of load failures, so list them.
  # Some tests request a file on purpose to prove it's gone, so a 404 here
  # isn't automatically a problem.
  echo ""
  echo "Files requested but not found (HTTP 404):"
  grep '" 404 ' "$WORK_DIR/server.log" | sed -E 's/.*"(GET [^"]*)".*/  \1/' | sort -u
fi

exit "$result"
