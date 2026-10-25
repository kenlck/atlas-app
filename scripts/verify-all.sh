#!/usr/bin/env bash
# Full local check. Replaces the GitHub Actions workflow.
# Writes artifacts/<head sha>/ and exits non-zero on the first failure.
# Throwaway secrets stay in the process environment. They are not printed.
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "refusing dirty tree" >&2
  git status --porcelain >&2
  exit 1
fi

SHA=$(git rev-parse HEAD)
ART="artifacts/${SHA}"
rm -rf "$ART" || exit 1
LOG="${ART}/logs"
mkdir -p "$LOG"

umask 077
REDACTOR=$(mktemp)
PG_ENV=
SERVER_PID=
PG_CONTAINER=
STARTED_CONTAINERS=
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea"

# Job control is off. set -m puts each command in its own process group and
# takes the terminal; with stdout piped or no tty that stops ensure_psql with
# SIGTTOU (exit 150). The dev server is started under setsid so this run can
# still signal that process group. The trap removes only containers recorded
# for this process, and exits with the status it was entered with.
track_container() {
  STARTED_CONTAINERS="${STARTED_CONTAINERS:+$STARTED_CONTAINERS }$1"
}

cleanup() {
  local status=$?
  local name
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill -- "-${SERVER_PID}" >/dev/null 2>&1 || kill "${SERVER_PID}" >/dev/null 2>&1 || true
    SERVER_PID=
  fi
  for name in ${STARTED_CONTAINERS:-}; do
    docker rm -f "$name" >/dev/null 2>&1 || true
  done
  rm -f "${REDACTOR:-}" "${PG_ENV:-}"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cat > "$REDACTOR" << 'PY'
import os
import re
import sys
from urllib.parse import urlparse

values = []
for key in ("ADMIN_API_SECRET", "BETTER_AUTH_SECRET", "DATABASE_URL"):
    value = os.environ.get(key) or ""
    if len(value) >= 12:
        values.append(value)
url = os.environ.get("DATABASE_URL") or ""
if "://" in url:
    password = urlparse(url).password or ""
    if len(password) >= 8:
        values.append(password)
values.sort(key=len, reverse=True)
pattern = re.compile(r"postgres(?:ql)?://\S+")

def clean(text: str) -> str:
    for value in values:
        text = text.replace(value, "[redacted]")
    return pattern.sub("[redacted-url]", text)

buf = ""
while True:
    chunk = sys.stdin.read(4096)
    if not chunk:
        break
    buf += chunk
    lines = buf.split("\n")
    buf = lines.pop()
    for line in lines:
        sys.stdout.write(clean(line) + "\n")
    sys.stdout.flush()
if buf:
    sys.stdout.write(clean(buf))
    sys.stdout.flush()
PY

export BETTER_AUTH_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export ADMIN_API_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export BETTER_AUTH_URL="http://127.0.0.1:3000"
export BASE_URL="http://127.0.0.1:3000"
export ATLAS_CONTAINER="atlas-verify"
export VISUAL_OUT="artifacts"

run_step() {
  local name=$1
  shift
  local log="${LOG}/${name}.log"
  local raw code redact_code
  raw=$(mktemp)
  echo "START $(date -u +%Y-%m-%dT%H:%M:%SZ) sha=${SHA}" > "$log"
  set +e
  "$@" > "$raw" 2>&1
  code=$?
  python3 -u "$REDACTOR" < "$raw" >> "$log"
  redact_code=$?
  rm -f "$raw"
  echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ) sha=${SHA}" >> "$log"
  if [[ "$redact_code" -ne 0 ]]; then
    echo "redactor failed for ${name}" >&2
    exit 1
  fi
  cat "$log"
  if [[ "$code" -ne 0 ]]; then
    echo "step ${name} failed" >&2
    exit "$code"
  fi
}

require_step_log() {
  local name=$1
  shift
  local needle
  for needle in "$@"; do
    if ! grep -F -q -- "$needle" "${LOG}/${name}.log"; then
      echo "step ${name} failed" >&2
      exit 1
    fi
  done
}

pick_port() {
  # Kernel ephemeral port. Never probes 5432.
  local port attempt
  for attempt in 1 2 3 4 5; do
    port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()') || return 1
    if [[ "$port" != "5432" ]]; then
      echo "$port"
      return 0
    fi
  done
  echo "no free local port for Postgres" >&2
  return 1
}

prepare_database() {
  # Always use the throwaway container. An inherited URL, local or not, is
  # dropped here. The old guard exited 2 for a remote URL and then returned 0,
  # so the unchecked status still exported that URL.
  if [[ -n "${DATABASE_URL:-}" ]]; then
    echo "inherited_database_url=ignored"
    unset DATABASE_URL
  fi

  local port password ready="false" i lines
  port=$(pick_port) || return 1
  password=$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')
  PG_ENV=$(mktemp)
  python3 - "$PG_ENV" "$password" << 'PY'
import sys
from pathlib import Path

path, pg_password = sys.argv[1], sys.argv[2]
Path(path).write_text(
    "POSTGRES_USER=atlas\n" + f"POSTGRES_PASSWORD={pg_password}\n" + "POSTGRES_DB=atlas\n"
)
os_chmod = Path(path)
os_chmod.chmod(0o600)
PY
  PG_CONTAINER="atlas-verify-all-pg-$$"
  track_container "$PG_CONTAINER"
  echo "CMD docker run -d --name ${PG_CONTAINER} --env-file <unprinted> -p 127.0.0.1:${port}:5432 postgres:16"
  docker run -d --name "$PG_CONTAINER" --env-file "$PG_ENV" -p "127.0.0.1:${port}:5432" postgres:16 || return 1
  rm -f "$PG_ENV"
  PG_ENV=
  for i in $(seq 1 90); do
    lines=$(docker logs "$PG_CONTAINER" 2>&1 | grep -c "database system is ready to accept connections" || true)
    if [[ "$lines" -ge 2 ]] && docker exec "$PG_CONTAINER" pg_isready -q -h 127.0.0.1 -U atlas; then
      ready="true"
      break
    fi
    sleep 1
  done
  echo "postgres_ready=${ready}"
  echo "database_host=127.0.0.1"
  echo "database_port=${port}"
  if [[ "$ready" != "true" ]]; then
    return 1
  fi
  export DATABASE_URL="postgres://atlas:${password}@127.0.0.1:${port}/atlas"
  export TEST_DATABASE_URL="$DATABASE_URL"
}

free_port_3000() {
  local i pid cmd
  for i in $(seq 1 20); do
    pid=$(ss -ltnp | sed -n 's/.*:3000 .*pid=\([0-9]*\).*/\1/p' | head -1 || true)
    if [[ -z "${pid:-}" ]]; then
      return 0
    fi
    cmd=$(ps -p "$pid" -o cmd= || true)
    case "$cmd" in
      *".output/server/index.mjs"*)
        kill "$pid" >/dev/null 2>&1 || true
        sleep 0.3
        if kill -0 "$pid" >/dev/null 2>&1; then
          kill -9 "$pid" >/dev/null 2>&1 || true
        fi
        ;;
      *)
        echo "port 3000 is in use" >&2
        return 1
        ;;
    esac
  done
  echo "port 3000 stayed busy" >&2
  return 1
}

stop_server() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill -- "-${SERVER_PID}" >/dev/null 2>&1 || kill "${SERVER_PID}" >/dev/null 2>&1 || true
    sleep 0.5
    if kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
      kill -9 -- "-${SERVER_PID}" >/dev/null 2>&1 || kill -9 "${SERVER_PID}" >/dev/null 2>&1 || true
    fi
    SERVER_PID=
    echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ) sha=${SHA}" >> "${LOG}/server.log"
  fi
  free_port_3000
}

start_server() {
  stop_server || return 1
  docker rm -f atlas-verify >/dev/null 2>&1 || true
  echo "START $(date -u +%Y-%m-%dT%H:%M:%SZ) sha=${SHA}" > "${LOG}/server.log"
  setsid bash -c 'pnpm start 2>&1 | python3 -u "$1"' _ "$REDACTOR" >> "${LOG}/server.log" < /dev/null &
  SERVER_PID=$!
}

wait_for_sign_in() {
  local i
  for i in $(seq 1 90); do
    if curl -sf -o /dev/null http://127.0.0.1:3000/sign-in; then
      echo "sign_in_status=200"
      return 0
    fi
    sleep 1
  done
  echo "sign_in_status=down"
  return 1
}

ensure_psql() {
  if command -v psql >/dev/null 2>&1; then
    echo "psql=present"
    return 0
  fi
  sudo apt-get update && sudo apt-get install -y postgresql-client
}

build_image() {
  echo "CMD docker build -t atlas-app -t atlas-app:${SHA} ."
  docker build -t atlas-app -t "atlas-app:${SHA}" . || return 1
  export ATLAS_IMAGE="atlas-app:${SHA}"
}

migrate_image() {
  echo "CMD docker run --rm --network host -e DATABASE_URL ${ATLAS_IMAGE} node migrate.mjs"
  docker run --rm --network host -e DATABASE_URL "$ATLAS_IMAGE" node migrate.mjs
}

start_image() {
  stop_server || return 1
  docker rm -f atlas-verify >/dev/null 2>&1 || true
  track_container atlas-verify
  echo "CMD docker run -d --name atlas-verify --network host -e DATABASE_URL -e BETTER_AUTH_SECRET -e BETTER_AUTH_URL -e ADMIN_API_SECRET ${ATLAS_IMAGE}"
  docker run -d --name atlas-verify --network host \
    -e DATABASE_URL -e BETTER_AUTH_SECRET -e BETTER_AUTH_URL -e ADMIN_API_SECRET \
    -e HOST=127.0.0.1 -e PORT=3000 \
    "$ATLAS_IMAGE" || return 1
  local running
  running=$(docker inspect -f '{{.State.Running}}' atlas-verify 2>/dev/null || echo false)
  echo "container_running=${running}"
  if [[ "$running" != "true" ]]; then
    return 1
  fi
  wait_for_sign_in
}

run_baselines() {
  echo "CMD docker run --rm --network host pinned-playwright-image node node_modules/@playwright/test/cli.js test -c playwright.visual.config.ts"
  docker run --rm --network host \
    -v "$PWD:/work" -w /work \
    -e "ATLAS_PLAYWRIGHT_IMAGE=${PLAYWRIGHT_IMAGE}" \
    -e BASE_URL=http://127.0.0.1:3000 \
    -e ADMIN_API_SECRET \
    -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    "$PLAYWRIGHT_IMAGE" \
    node node_modules/@playwright/test/cli.js test -c playwright.visual.config.ts
}

run_side_by_side() {
  git fetch origin main || return 1
  BASELINE_FROM=origin/main pnpm exec tsx scripts/baseline-side-by-side.ts
}

sweep_artifacts() {
  python3 - "$ART" << 'PY'
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

root = Path(sys.argv[1])
values = []
for key in ("ADMIN_API_SECRET", "BETTER_AUTH_SECRET", "DATABASE_URL"):
    value = os.environ.get(key) or ""
    if len(value) >= 12:
        values.append(value)
url = os.environ.get("DATABASE_URL") or ""
if "://" in url:
    password = urlparse(url).password or ""
    if len(password) >= 8:
        values.append(password)
values.sort(key=len, reverse=True)
pattern = re.compile(r"postgres(?:ql)?://\S+")
for path in root.rglob("*"):
    if not path.is_file() or path.suffix.lower() == ".png":
        continue
    data = path.read_bytes()
    if b"\0" in data[:1024]:
        continue
    text = data.decode("utf-8", "replace")
    new = text
    for value in values:
        new = new.replace(value, "[redacted]")
    new = pattern.sub("[redacted-url]", new)
    if new != text:
        path.write_text(new)
PY
}

run_step postgres prepare_database
run_step install pnpm install --frozen-lockfile
run_step migrate pnpm db:migrate
run_step typecheck pnpm typecheck
run_step test pnpm test
run_step build pnpm build
run_step playwright-install pnpm exec playwright install --with-deps chromium
start_server || exit 1
run_step server-ready wait_for_sign_in
run_step visual-shots pnpm visual-shots
run_step calendar-view pnpm calendar-view
require_step_log calendar-view "month_grid=visible" "agenda_at_1280=hidden" "month_crossing_bar=true" "agenda_at_390=visible" "calendar_view=pass"
run_step autosave-flush pnpm autosave-flush
run_step tokens node scripts/lint-tokens.mjs
run_step docker-build build_image
run_step psql ensure_psql
run_step verify-migrate migrate_image
run_step verify-start start_image
run_step token-revoked ./scripts/verify-fail-conditions.sh token-revoked
require_step_log token-revoked "before_revoke_status=200" "revoked_status=401"
run_step token-cross ./scripts/verify-fail-conditions.sh token-cross
require_step_log token-cross "owner_status=200" "cross_user_status=404" "cross_search_status=200" "cross_search_visible=false"
run_step token-secret ./scripts/verify-fail-conditions.sh token-secret
require_step_log token-secret "token_in_db=false" "token_in_logs=false"
run_step token-bearer ./scripts/verify-fail-conditions.sh token-bearer
require_step_log token-bearer "missing_bearer_status=401" "garbage_bearer_status=401" "bearer_bodies_match=true" "revoked_bearer_status=401" "unknown_bearer_status=401" "expired_bearer_status=401" "bearer_bodies_identical=true"
run_step token-writes ./scripts/verify-fail-conditions.sh token-writes
require_step_log token-writes "create_denied_status=404" "update_denied_status=404"
run_step token-team ./scripts/verify-fail-conditions.sh token-team
require_step_log token-team "before_removal_status=200" "remove_status=200" "after_removal_status=404"
run_step token-reset ./scripts/verify-fail-conditions.sh token-reset
require_step_log token-reset "before_reset_status=200" "reset_status=200" "reset_image=atlas-app" "reset_container_removed=true" "pending_status=401" "password_status=200" "after_password_status=401"
run_step token-roundtrip ./scripts/verify-fail-conditions.sh token-roundtrip
require_step_log token-roundtrip "create_status=200" "read_status=200" "update_status=200" "search_status=200" "search_visible=true" "list_status=200" "app_status=200" "app_title_matches=true" "last_used_set=true"
run_step token-image ./scripts/verify-fail-conditions.sh token-image
require_step_log token-image "app_containers=1" "same_image=true" "mcp_status=401" "mcp_get_status=405" "extra_service=false"
run_step token-fidelity ./scripts/verify-fail-conditions.sh token-fidelity
require_step_log token-fidelity "get_status=200" "update_status=200" "mention_link=true" "date_link=true" "table_markup=true" "stored_body_identical=true"
run_step token-conflict ./scripts/verify-fail-conditions.sh token-conflict
require_step_log token-conflict "missing_status=409" "missing_unchanged=true" "stale_status=409" "stale_unchanged=true" "parent_status=400" "reparent_status=400" "parent_unchanged=true"
run_step token-scope ./scripts/verify-fail-conditions.sh token-scope
require_step_log token-scope "read_create_status=403" "read_update_status=403" "read_get_status=200" "read_create_stored=false" "read_title_unchanged=true" "read_search_status=200" "read_search_visible=true" "write_search_status=200" "write_search_visible=true"
run_step token-expiry ./scripts/verify-fail-conditions.sh token-expiry
require_step_log token-expiry "before_expiry_status=200" "expired_status=401" "expired_body_matches=true"
run_step token-rate ./scripts/verify-fail-conditions.sh token-rate
require_step_log token-rate "under_limit_status=200" "rate_status=429" "rate_limit=60"
run_step token-body ./scripts/verify-fail-conditions.sh token-body
require_step_log token-body "body_status=413" "body_limit_bytes=1048576" "stored_pages=0"
run_step token-search ./scripts/verify-fail-conditions.sh token-search
require_step_log token-search "team_search_status=200" "owner_search_visible=true" "cross_team_search_visible=false"
run_step token-mention ./scripts/verify-fail-conditions.sh token-mention
require_step_log token-mention "mention_create_real_visible=true" "mention_create_fake_visible=false" "mention_update_real_visible=true" "mention_update_fake_visible=false" "mention_update_decoy_visible=false"
run_step fail1 ./scripts/verify-fail-conditions.sh 1
run_step fail2 ./scripts/verify-fail-conditions.sh 2
run_step fail3 ./scripts/verify-fail-conditions.sh 3
run_step fail4 ./scripts/verify-fail-conditions.sh 4
run_step fail5a ./scripts/verify-fail-conditions.sh 5a
run_step fail5e ./scripts/verify-fail-conditions.sh 5e
run_step fail5b ./scripts/verify-fail-conditions.sh 5b
run_step fail5h ./scripts/verify-fail-conditions.sh 5h
run_step fail5c ./scripts/verify-fail-conditions.sh 5c
run_step fail5d ./scripts/verify-fail-conditions.sh 5d
run_step fail5f ./scripts/verify-fail-conditions.sh 5f
run_step fail5g ./scripts/verify-fail-conditions.sh 5g
run_step forgot-password ./scripts/verify-fail-conditions.sh forgot-password
run_step design-lock ./scripts/verify-fail-conditions.sh design-lock
run_step fail3-1 ./scripts/verify-fail-conditions.sh 3-1
run_step fail3-2 ./scripts/verify-fail-conditions.sh 3-2
run_step fail3-3 ./scripts/verify-fail-conditions.sh 3-3
run_step fail3-4 ./scripts/verify-fail-conditions.sh 3-4
run_step fail3-5 ./scripts/verify-fail-conditions.sh 3-5
run_step space-error ./scripts/verify-fail-conditions.sh space-error
run_step fail6 ./scripts/verify-fail-conditions.sh 6
run_step fail7 ./scripts/verify-fail-conditions.sh 7
require_step_log fail7 "BETTER_AUTH_SECRET is required" "names_BETTER_AUTH_SECRET=true"
run_step fail7a ./scripts/verify-fail-conditions.sh 7a
require_step_log fail7a "ADMIN_API_SECRET is required" "names_ADMIN_API_SECRET=true"
run_step fail8 ./scripts/verify-fail-conditions.sh 8
require_step_log fail8 "resolved=proxy" "auth_statuses=401,401,401,429"
run_step fail9 ./scripts/verify-fail-conditions.sh 9
require_step_log fail9 "cross_origin_status=403"
run_step fail9a ./scripts/verify-fail-conditions.sh 9a
require_step_log fail9a "malformed_status=400"
run_step fail5-1 ./scripts/verify-fail-conditions.sh 5-1
require_step_log fail5-1 "non_member_calendar_status=404" "non_member_create_status=404" "non_member_update_status=404" "non_member_delete_status=404" "other_team_event_visible=false"
run_step fail5-2 ./scripts/verify-fail-conditions.sh 5-2
require_step_log fail5-2 "invalid_range_status=400" "wrote_invalid=false"
run_step fail5-3 ./scripts/verify-fail-conditions.sh 5-3
require_step_log fail5-3 "stored_start=2026-06-16T01:00:00.000Z" "kiritimati=2026-06-16 15:00" "midway=2026-06-15 14:00" "same_instant=true" "all_day_shifted=false"
run_step fail5-4 ./scripts/verify-fail-conditions.sh 5-4
require_step_log fail5-4 "january_contains=true" "february_contains=true"
run_step fail4-1 ./scripts/verify-fail-conditions.sh 4-1
require_step_log fail4-1 "cross_team_visible=false" "other_personal_visible=false" "archived_visible=false" "archived_child_visible=false" "own_team_visible=true" "own_personal_visible=true"
run_step fail4-2 ./scripts/verify-fail-conditions.sh 4-2
require_step_log fail4-2 "percent_literal=true" "underscore_literal=true" "backslash_literal=true"
run_step fail4-3 ./scripts/verify-fail-conditions.sh 4-3
require_step_log fail4-3 "body_only_visible=true"
run_step fail4-4 ./scripts/verify-fail-conditions.sh 4-4
require_step_log fail4-4 "autosave_visible=true"
run_step fail4-5 ./scripts/verify-fail-conditions.sh 4-5
require_step_log fail4-5 "backfill_body_text=true" "migration_updates_body_text=true"
run_step fail4-6 ./scripts/verify-fail-conditions.sh 4-6
require_step_log fail4-6 "table_label_visible=true" "mention_label_visible=true" "date_label_visible=true"
run_step fail4-7 ./scripts/verify-fail-conditions.sh 4-7
require_step_log fail4-7 "safe_amp=200" "safe_paren=200" "safe_prefix_syntax=200" "safe_quote=200" "safe_backslash=200" "safe_emoji=200" "safe_empty=200" "safe_one=200"
run_step screenshots pnpm visual-shots
run_step baselines run_baselines
run_step baseline-side-by-side run_side_by_side
sweep_artifacts || {
  echo "sweep_artifacts failed" >&2
  exit 1
}

if [[ -n "$(git status --porcelain)" ]]; then
  echo "tree became dirty" >&2
  git status --porcelain >&2
  exit 1
fi

echo "verify_all sha=${SHA} result=pass" | tee "${ART}/result.txt"
