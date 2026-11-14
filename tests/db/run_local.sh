#!/usr/bin/env bash
#
# tests/db/run_local.sh: run the SQL tests against a throwaway local Postgres
# (ADR-013). This is an optional fast loop for development. The real check is
# still running each test file in the Supabase SQL Editor against the dev
# project (ADR-001).
#
# 1. Creates a brand-new Postgres cluster in a temp directory. It listens on a
#    Unix socket only (no TCP), so nothing on the network can reach it and it
#    can't clash with any other Postgres on this machine.
# 2. Applies tests/db/supabase_stub.sql, which provides the roles, auth.users
#    and auth.uid() that our migrations expect from Supabase.
# 3. Applies db/migrations/*.sql in order, as the `postgres` role (as in the
#    Supabase SQL Editor), and then applies them all a second time to prove the
#    migrations can be safely re-run.
# 4. Applies db/seed/*.sql, if any, in order.
# 5. Runs each test file and prints a PASS/FAIL summary.
# 6. Stops the cluster and deletes it, even on failure or Ctrl-C.
#
# Needs PostgreSQL's command-line tools (initdb, pg_ctl, psql), for example
# `brew install postgresql@17`. They are a development tool only: the site
# and the project have no dependency on them.
#
# Usage (from anywhere):
#   tests/db/run_local.sh                                   # every tests/db/test_*.sql
#   tests/db/run_local.sh tests/db/test_002_schema.sql      # just these files
#   PG_BIN=/path/to/postgres/bin tests/db/run_local.sh      # non-default install
#
# Exit codes: 0 = all passed, 1 = a migration or test failed, 2 = setup problem.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly STUB_FILE="$REPO_ROOT/tests/db/supabase_stub.sql"
readonly MIGRATIONS_DIR="$REPO_ROOT/db/migrations"
readonly SEED_DIR="$REPO_ROOT/db/seed"
# Homebrew install locations for Apple Silicon and Intel Macs.
readonly HOMEBREW_PG_BINS=("/opt/homebrew/opt/postgresql@17/bin" "/usr/local/opt/postgresql@17/bin")
# The bootstrap superuser is named after Supabase's own superuser. Only the
# stub runs as it; migrations and tests run as the non-superuser `postgres`.
readonly SUPERUSER="supabase_admin"
readonly APP_ROLE="postgres"
readonly DATABASE="postgres"
# The port only names the socket file. The socket lives in a private
# directory, so any fixed value is safe.
readonly PORT=5432
# macOS limits Unix socket paths to 104 bytes. "/.s.PGSQL.5432" adds 14 more.
readonly MAX_SOCKET_DIR_LENGTH=89
readonly SERVER_START_TIMEOUT_S=30
readonly EXIT_FAILED=1
readonly EXIT_SETUP_PROBLEM=2

find_pg_bin() {
  if [[ -n "${PG_BIN:-}" ]]; then
    echo "$PG_BIN"
    return
  fi
  if command -v pg_config >/dev/null 2>&1; then
    pg_config --bindir
    return
  fi
  local candidate
  for candidate in "${HOMEBREW_PG_BINS[@]}"; do
    if [[ -x "$candidate/psql" ]]; then
      echo "$candidate"
      return
    fi
  done
  echo ""
}

PG_BIN_DIR="$(find_pg_bin)"
readonly PG_BIN_DIR
for tool in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN_DIR/$tool" ]]; then
    echo "PostgreSQL tool '$tool' not found${PG_BIN_DIR:+ in $PG_BIN_DIR}." >&2
    echo "Install it (brew install postgresql@17) or set PG_BIN to its bin directory." >&2
    exit "$EXIT_SETUP_PROBLEM"
  fi
done

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bgo-sqltest.XXXXXX")"
readonly WORK_DIR
readonly DATA_DIR="$WORK_DIR/data"
SOCKET_DIR="$WORK_DIR"
if (( ${#SOCKET_DIR} > MAX_SOCKET_DIR_LENGTH )); then
  SOCKET_DIR="$(mktemp -d /tmp/bgo-pg.XXXXXX)"
fi
readonly SOCKET_DIR
SERVER_STARTED=false

cleanup() {
  if [[ "$SERVER_STARTED" == true ]]; then
    "$PG_BIN_DIR/pg_ctl" -D "$DATA_DIR" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
  if [[ "$SOCKET_DIR" != "$WORK_DIR" ]]; then
    rm -rf "$SOCKET_DIR"
  fi
}
trap cleanup EXIT

# Runs one SQL file as the given role. Notices (e.g. "already exists,
# skipping" when migrations are re-applied) are hidden; errors are not.
run_sql_file() {
  local role="$1" file="$2"
  PGOPTIONS="-c client_min_messages=warning" "$PG_BIN_DIR/psql" \
    --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
    --host "$SOCKET_DIR" --port "$PORT" --username "$role" --dbname "$DATABASE" \
    --file "$file" 2>&1
}

# Applies every .sql file in a directory, in name order. Stops at the first failure.
apply_dir() {
  local dir="$1" label="$2" file output
  shopt -s nullglob
  local files=("$dir"/*.sql)
  shopt -u nullglob
  # macOS ships bash 3.2, where expanding an empty array under `set -u` is a fatal error.
  if (( ${#files[@]} == 0 )); then
    echo "· $label: none found"
    return 0
  fi
  for file in "${files[@]}"; do
    if ! output="$(run_sql_file "$APP_ROLE" "$file")"; then
      echo "✗ $label: ${file#"$REPO_ROOT"/}"
      echo "$output" | sed 's/^/    /'
      return 1
    fi
  done
  echo "✓ $label (${#files[@]} file(s))"
}

# --- 1. Throwaway cluster ------------------------------------------------------

if ! "$PG_BIN_DIR/initdb" --pgdata "$DATA_DIR" --username "$SUPERUSER" --auth trust \
    --encoding UTF8 --locale en_US.UTF-8 --no-instructions >"$WORK_DIR/initdb.log" 2>&1; then
  echo "initdb failed:" >&2
  cat "$WORK_DIR/initdb.log" >&2
  exit "$EXIT_SETUP_PROBLEM"
fi

# listen_addresses='' disables TCP. fsync=off is safe because the cluster is deleted afterwards.
if ! "$PG_BIN_DIR/pg_ctl" --pgdata "$DATA_DIR" --log "$WORK_DIR/server.log" --wait \
    --timeout "$SERVER_START_TIMEOUT_S" \
    -o "-c listen_addresses='' -c unix_socket_directories='$SOCKET_DIR' -c port=$PORT -c fsync=off" \
    start >/dev/null 2>&1; then
  echo "Postgres failed to start:" >&2
  cat "$WORK_DIR/server.log" >&2
  exit "$EXIT_SETUP_PROBLEM"
fi
SERVER_STARTED=true

# --- 2. Supabase stand-in ------------------------------------------------------

if ! output="$(run_sql_file "$SUPERUSER" "$STUB_FILE")"; then
  echo "✗ Supabase stub failed to apply:" >&2
  echo "$output" | sed 's/^/    /' >&2
  exit "$EXIT_SETUP_PROBLEM"
fi

# --- 3–4. Migrations (twice) and seeds ------------------------------------------

apply_dir "$MIGRATIONS_DIR" "migrations applied" || exit "$EXIT_FAILED"
apply_dir "$MIGRATIONS_DIR" "migrations re-applied (must be safe to re-run)" || exit "$EXIT_FAILED"
apply_dir "$SEED_DIR" "seed data applied" || exit "$EXIT_FAILED"

# --- 5. Tests -------------------------------------------------------------------

if (( $# > 0 )); then
  test_files=("$@")
else
  shopt -s nullglob
  test_files=("$REPO_ROOT"/tests/db/test_*.sql)
  shopt -u nullglob
fi

if (( ${#test_files[@]} == 0 )); then
  # Zero tests almost always means a broken path or glob, never a pass.
  echo "FAIL — no SQL test files found"
  exit "$EXIT_FAILED"
fi

passed=0
for test_file in "${test_files[@]}"; do
  display_name="${test_file#"$REPO_ROOT"/}"
  if output="$(run_sql_file "$APP_ROLE" "$test_file")"; then
    passed=$((passed + 1))
    echo "✓ $display_name"
  else
    echo "✗ $display_name"
    echo "$output" | sed 's/^/    /'
  fi
done

total=${#test_files[@]}
if (( passed == total )); then
  echo "PASS — $passed/$total SQL test files passed"
else
  echo "FAIL — $((total - passed)) of $total SQL test files failed"
  exit "$EXIT_FAILED"
fi
