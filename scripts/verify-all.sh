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
  if [[ "$status" -ne 0 && -n "${SHA:-}" ]]; then
    echo "verify_all sha=${SHA} result=fail"
    if [[ -n "${ART:-}" && -d "$ART" ]]; then
      echo "verify_all sha=${SHA} result=fail" > "${ART}/result.txt"
    fi
  fi
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
  if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
    echo "inherited_test_database_url=ignored"
    unset TEST_DATABASE_URL
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

refuse_remote_database() {
  pnpm exec tsx scripts/assert-local-database.ts --require
}

migrate_schema() {
  refuse_remote_database || return 1
  pnpm db:migrate
}

migrate_image() {
  refuse_remote_database || return 1
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
run_step migrate migrate_schema
run_step typecheck pnpm typecheck
run_step lint pnpm lint
run_step test pnpm test
run_step test-db-guard ./scripts/verify-fail-conditions.sh test-db-guard
require_step_log test-db-guard "test_db_guard_remote_refused=true" "test_db_guard_multihost_refused=true" "test_db_guard_double_at_refused=true" "test_db_guard_encoded_multihost_refused=true" "test_db_guard_ipv6_local=true" "test_db_guard_encoded_local=true" "result=pass"
run_step build pnpm build
run_step playwright-install pnpm exec playwright install --with-deps chromium
run_step fc1 ./scripts/verify-fail-conditions.sh fc1
require_step_log fc1 "fc1_main_accepts_planted=true" "fc1_head_rejects_planted=true" "fc1_head_accepts_cycle=true" "fc1_head_rejects_loose=true" "fc1=pass"
run_step fc2 ./scripts/verify-fail-conditions.sh fc2
require_step_log fc2 "fc2_planted_has_first=true" "fc2_planted_first_silent=true" "fc2_head_first_absent=true" "fc2_multi_match_fails=true" "fc2_exact_text_passes=true" "fc2=pass"
run_step fc3 ./scripts/verify-fail-conditions.sh fc3
require_step_log fc3 "fc3_main_misses_planted=true" "fc3_head_catches_planted=true" "fc3_head_catches_audit=true" "fc3_clean_passes=true" "verify_password_not_in_logs=false" "verify_password_not_in_logs=true" "verify_password_not_in_audit=false" "verify_password_not_in_audit=true" "fc3=pass"
run_step fc4 ./scripts/verify-fail-conditions.sh fc4
require_step_log fc4 "fc1_planted_accepted=false" "fc4_fc1_planted_exit=1" "fc1=pass" "fc4_fc1_head_exit=0" "fc2_planted_has_first=true" "fc4_fc2_planted_exit=1" "fc2=pass" "fc4_fc2_head_exit=0" "fc3_planted_present=true" "verify_password_not_in_logs=false" "fc4_fc3_planted_exit=1" "fc3=pass" "fc4_fc3_head_exit=0" "fc4=pass"
start_server || exit 1
run_step server-ready wait_for_sign_in
run_step visual-shots pnpm visual-shots
run_step calendar-view pnpm calendar-view
require_step_log calendar-view "month_grid=visible" "agenda_at_1280=hidden" "month_crossing_bar=true" "agenda_at_390=visible" "calendar_view=pass"
run_step autosave-flush pnpm autosave-flush
require_step_log autosave-flush "reload_exact_match=true" "navigate_exact_match=true" "unload_origin_matches=true" "unload_save_accepted=true"
run_step tokens node scripts/lint-tokens.mjs
run_step docker-build build_image
run_step psql ensure_psql
run_step auto-migrate-a ./scripts/verify-fail-conditions.sh auto-migrate-a
require_step_log auto-migrate-a "auto_migrate_a result=pass" "exit_code=0" "http_code=200" "rows_match_journal=true" "user_table=true" "recipe_exit=0"
run_step auto-migrate-b ./scripts/verify-fail-conditions.sh auto-migrate-b
require_step_log auto-migrate-b "auto_migrate_b result=pass" "partial_exit=0" "forward_exit=0" "http_code=200" "moved_forward=true" "rows_match_journal=true" "recipe_exit=0"
run_step auto-migrate-c ./scripts/verify-fail-conditions.sh auto-migrate-c
require_step_log auto-migrate-c "auto_migrate_c result=pass" "first_exit=0" "second_exit=0" "http_code=200" "rows_unchanged=true" "recipe_exit=0"
run_step auto-migrate-d ./scripts/verify-fail-conditions.sh auto-migrate-d
require_step_log auto-migrate-d "auto_migrate_d result=pass" "first_exit=0" "second_exit=0" "advisory_lock_held=true" "rows_match_journal=true" "recipe_exit=0"
run_step auto-migrate-e ./scripts/verify-fail-conditions.sh auto-migrate-e
require_step_log auto-migrate-e "auto_migrate_e result=pass" "exit_code_nonzero=true" "port_open=false" "server_started=false" "recipe_exit=0"
run_step auto-migrate-f ./scripts/verify-fail-conditions.sh auto-migrate-f
require_step_log auto-migrate-f "auto_migrate_f result=pass" "exit_code=0" "http_code=200" "schema_objects=0" "cmdline=node .output/server/index.mjs" "migrate_logged=false" "recipe_exit=0"
run_step verify-migrate migrate_image
run_step verify-start start_image
run_step healthcheck ./scripts/verify-fail-conditions.sh healthcheck
run_step 18-fc1 ./scripts/verify-fail-conditions.sh 18-fc1
require_step_log 18-fc1 "fc1_planted_sqlstate=23505" "fc1_planted_http_409=0" "fc1_absent_exit=0" "fc1_head_status=409" "fc1_head_message=Already invited" "fc1_head_rows=1" "fc1_ui_alert=Already invited" "fc1_ui_card_kept=true" "18_fc1_planted_exit=1" "18_fc1_head_exit=0" "18_fc1=pass"
run_step 18-fc2 ./scripts/verify-fail-conditions.sh 18-fc2
require_step_log 18-fc2 "fc2_planted_stored=true" "fc2_absent_exit=0" "fc2_head_stored=false" "fc2_head_status=404" "18_fc2_planted_exit=1" "18_fc2_head_exit=0" "18_fc2=pass"
run_step 18-fc3 ./scripts/verify-fail-conditions.sh 18-fc3
require_step_log 18-fc3 "fc3_planted_sqlstate=23503" "fc3_planted_deleted=false" "fc3_absent_exit=0" "fc3_head_deleted=true" "fc3_head_invite_kept=true" "fc3_head_invited_by=null" "fc3_head_on_delete=n" "fc3_rule=set null" "18_fc3_planted_exit=1" "18_fc3_head_exit=0" "18_fc3=pass"
run_step 18-fc4 ./scripts/verify-fail-conditions.sh 18-fc4
require_step_log 18-fc4 "fc4_planted_status=409" "fc4_planted_error_count=0" "fc4_planted_row=Invited" "fc4_absent_exit=0" "fc4_send_status=409" "fc4_send_alert=Already invited" "fc4_send_card_kept=true" "fc4_remove_status=500" "fc4_remove_row_kept=true" "fc4_remove_alert=true" "fc4_delete_status=409" "fc4_delete_stayed=true" "fc4_delete_alert=true" "18_fc4_planted_exit=1" "18_fc4_head_exit=0" "18_fc4=pass"
run_step 18-fc5 ./scripts/verify-fail-conditions.sh 18-fc5
require_step_log 18-fc5 "fc5_planted_created=true" "fc5_planted_fail_surfaced=false" "fc5_planted_hang_settled=false" "fc5_absent_exit=0" "fc5_head_created=false" "fc5_head_within_5s=true" "fc5_fail_prompt=true" "fc5_fail_text_kept=true" "fc5_fail_url_kept=true" "fc5_hang_timed_out=true" "fc5_hang_text_kept=true" "fc5_hang_url_kept=true" "18_fc5_planted_exit=1" "18_fc5_head_exit=0" "18_fc5=pass"
run_step 18-fc6 ./scripts/verify-fail-conditions.sh 18-fc6
require_step_log 18-fc6 "fc6_planted_tab_reached_background=true" "fc6_absent_exit=0" "fc6_head_background_inert=true" "fc6_head_tab_left_dialog=false" "18_fc6_planted_exit=1" "18_fc6_head_exit=0" "18_fc6=pass"
run_step 18-fc7 ./scripts/verify-fail-conditions.sh 18-fc7
require_step_log 18-fc7 "fc7_planted_left_aligned=false" "fc7_planted_caret_matches_muted=false" "fc7_absent_exit=0" "fc7_head_left_aligned=true" "fc7_head_text_align=left" "fc7_head_caret_matches_muted=true" "18_fc7_planted_exit=1" "18_fc7_head_exit=0" "18_fc7=pass"
run_step 18-fc8 ./scripts/verify-fail-conditions.sh 18-fc8
require_step_log 18-fc8 "fc8_planted_steps=0" "fc8_absent_exit=0" "fc8_head_missing=" "fc8_head_recipe_missing=" "18_fc8_planted_exit=1" "18_fc8_head_exit=0" "18_fc8=pass"
require_step_log healthcheck "healthcheck_status=200" "healthcheck_location=absent"
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
require_step_log fail4 "move_under_child_status=400" "move_under_child_message=Cannot move a page under itself or a descendant" "move_under_child_message_exact=true" "move_under_self_status=400" "move_under_self_message=Cannot move a page under itself or a descendant" "move_under_self_message_exact=true"
run_step fail5a ./scripts/verify-fail-conditions.sh 5a
run_step fail5e ./scripts/verify-fail-conditions.sh 5e
run_step fail5b ./scripts/verify-fail-conditions.sh 5b
run_step fail5h ./scripts/verify-fail-conditions.sh 5h
run_step fail5c ./scripts/verify-fail-conditions.sh 5c
run_step fail5d ./scripts/verify-fail-conditions.sh 5d
run_step fail5f ./scripts/verify-fail-conditions.sh 5f
require_step_log fail5f "secret_not_in_logs=true" "temp_not_in_logs=true" "new_not_in_logs=true" "verify_password_not_in_logs=true" "secret_not_in_audit=true" "temp_not_in_audit=true" "new_not_in_audit=true" "verify_password_not_in_audit=true"
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
run_step fail10 ./scripts/verify-fail-conditions.sh 10
require_step_log fail10 "inherited_database_url=ignored" "database_url_visible=false" "bad_statuses=401,401,401,401,401,429" "limited_ip_valid_status=200" "limited_ip_still_bad=429" "other_ip_status=200" "success_statuses=200,200,200,200,200,200" "success_does_not_consume=true" "after_success_bad=401"
run_step fail9 ./scripts/verify-fail-conditions.sh 9
require_step_log fail9 "cross_origin_status=403"
run_step fail9a ./scripts/verify-fail-conditions.sh 9a
require_step_log fail9a "malformed_status=400"
run_step fail10-4 ./scripts/verify-fail-conditions.sh 10-4
require_step_log fail10-4 "missing_origin_status=403" "missing_origin_unchanged=true" "mismatched_origin_status=403" "mismatched_origin_unchanged=true" "malformed_status=400" "malformed_unchanged=true" "matching_origin_status=204" "matching_origin_accepted=true"
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
run_step fail7-1 ./scripts/verify-fail-conditions.sh 7-1
require_step_log fail7-1 "whiteboard_created=true" "sidebar_row_differs=true"
run_step fail7-2 ./scripts/verify-fail-conditions.sh 7-2
require_step_log fail7-2 "outsider_page_get=404" "outsider_page_post=404" "outsider_drawing_get=404" "outsider_drawing_post=404" "token_page_get=404" "token_page_post=404" "token_drawing_get=404" "token_drawing_post=404" "removed_page_get=404" "removed_page_post=404" "removed_token_get=404" "removed_token_post=404" "missing_status=404" "outsider_body_matches_missing=true" "token_body_matches_missing=true" "outsider_search_visible=false" "removed_search_visible=false"
run_step fail7-3 ./scripts/verify-fail-conditions.sh 7-3
require_step_log fail7-3 "reload_scene_identical=true"
run_step fail7-4 ./scripts/verify-fail-conditions.sh 7-4
require_step_log fail7-4 "flush_hidden_scene_identical=true" "waited_ms=2000" "autosave_aborted=true"
run_step fail7-5 ./scripts/verify-fail-conditions.sh 7-5
require_step_log fail7-5 "stale_status=409" "stale_body=true" "stored_unchanged=true" "reload_prompt=true"
run_step fail7-6 ./scripts/verify-fail-conditions.sh 7-6
require_step_log fail7-6 "oversize_status=413" "stored_oversize=false"
run_step fail7-7 ./scripts/verify-fail-conditions.sh 7-7
require_step_log fail7-7 "files_status=400" "image_status=400" "stored_rejected=false"
run_step fail7-8 ./scripts/verify-fail-conditions.sh 7-8
require_step_log fail7-8 "title_visible=true" "label_visible=true" "scene_secret_visible=false"
run_step fail7-9 ./scripts/verify-fail-conditions.sh 7-9
require_step_log fail7-9 "doc_excalidraw_requests=0" "board_excalidraw_requests=true" "watermark=absent" "library_visible=false" "collab_visible=false" "image_tool_visible=false"
run_step fail7-10 ./scripts/verify-fail-conditions.sh 7-10
require_step_log fail7-10 "read_body=Whiteboard, open in Atlas to view" "update_status=200" "scene_unchanged=true" "title_updated=true" "body_only_status=200"
run_step fail7-11 ./scripts/verify-fail-conditions.sh 7-11
require_step_log fail7-11 "archived_tree=false" "archived_search=false" "archived_mcp_status=404" "archived_drawing_status=404" "child_hidden=true"
run_step fail7-12 ./scripts/verify-fail-conditions.sh 7-12
require_step_log fail7-12 "scrollbar_1280=false" "scrollbar_390=false"
run_step fail7-13 ./scripts/verify-fail-conditions.sh 7-13
require_step_log fail7-13 "retry_banner=true"
run_step fail8-1 ./scripts/verify-fail-conditions.sh 8-1
require_step_log fail8-1 "outsider_page_get=404" "outsider_drawing_get=404" "token_page_get=404" "token_drawing_get=404" "missing_status=404" "outsider_body_matches_missing=true" "token_body_matches_missing=true" "result=pass"
run_step fail8-2 ./scripts/verify-fail-conditions.sh 8-2
require_step_log fail8-2 "placeholder_link=true" "update_status=200" "drawing_id_kept=true" "scene_unchanged=true" "result=pass"
run_step fail8-3 ./scripts/verify-fail-conditions.sh 8-3
require_step_log fail8-3 "block_removed=true" "drawing_row_kept=true" "scene_unchanged=true" "result=pass"
run_step fail8-4 ./scripts/verify-fail-conditions.sh 8-4
require_step_log fail8-4 "doc_excalidraw_requests=0" "result=pass"
run_step fail8-5 ./scripts/verify-fail-conditions.sh 8-5
require_step_log fail8-5 "label_visible=true" "scene_secret_visible=false" "body_text_has_secret=false" "result=pass"
run_step fail8-6 ./scripts/verify-fail-conditions.sh 8-6
require_step_log fail8-6 "reload_scene_identical=true" "retry_banner=true" "waited_ms=2000" "autosave_aborted=true" "flush_hidden_scene_identical=true" "result=pass"
run_step fail8-7 ./scripts/verify-fail-conditions.sh 8-7
require_step_log fail8-7 "archived_api=true" "archived_search=false" "archived_mcp_status=404" "result=pass"
run_step fail8-8 ./scripts/verify-fail-conditions.sh 8-8
require_step_log fail8-8 "duplicate_ids_differ=true" "duplicate_scene_copied=true" "original_unchanged=true" "paste_ids_differ=true" "paste_scene_copied=true" "result=pass"
run_step fail8-9 ./scripts/verify-fail-conditions.sh 8-9
require_step_log fail8-9 "before_edit_excalidraw_requests=0" "saw_spinner=true" "after_edit_excalidraw_requests=true" "library_visible=false" "collab_visible=false" "image_tool_visible=false" "result=pass"
run_step fail8-10 ./scripts/verify-fail-conditions.sh 8-10
require_step_log fail8-10 "stored_script=false" "stored_handler=false" "served_script=false" "served_handler=false" "result=pass"
run_step fail8-11 ./scripts/verify-fail-conditions.sh 8-11
require_step_log fail8-11 "foreign_id_rendered=false" "foreign_id_left_in_body=false" "copied_page_id_matches=true" "copied_scene_matches=true" "result=pass"
run_step fail8-12 ./scripts/verify-fail-conditions.sh 8-12
require_step_log fail8-12 "svg_in_drawing_row=true" "served_svg=true" "outsider_status=404" "file_storage=false" "result=pass"
run_step fail8-13 ./scripts/verify-fail-conditions.sh 8-13
require_step_log fail8-13 "node_copied=false" "node_response_leaks=false" "mcp_copied=false" "mcp_response_leaks=false" "unknown_matches_denied=true" "mcp_update_copied=false" "mcp_update_response_leaks=false" "archived_copied=false" "archived_response_leaks=false" "source_only=true" "result=pass"
run_step 37-fc1 ./scripts/verify-fail-conditions.sh 37-fc1
require_step_log 37-fc1 "fc1_save_requests=0" "fc1_text_unchanged=true" "fc1_title_unchanged=true" "fc1_editable=true" "fc1_reload_unchanged=true" "fc1_reload_view=true" "37_fc1=pass" "recipe_exit=0"
run_step 37-fc2 ./scripts/verify-fail-conditions.sh 37-fc2
require_step_log 37-fc2 "fc2_rule=true" "fc2_chip=true" "fc2_status=true" "fc2_text=true" "37_fc2=pass" "recipe_exit=0"
run_step 37-fc3 ./scripts/verify-fail-conditions.sh 37-fc3
require_step_log 37-fc3 "fc3_view=true" "fc3_persisted=true" "fc3_reload_view=true" "37_fc3=pass" "recipe_exit=0"
run_step 37-fc4 ./scripts/verify-fail-conditions.sh 37-fc4
require_step_log 37-fc4 "fc4_stayed=true" "fc4_banner=true" "fc4_discard=0" "fc4_retry_saved=true" "37_fc4=pass" "recipe_exit=0"
run_step 37-fc5 ./scripts/verify-fail-conditions.sh 37-fc5
require_step_log 37-fc5 "fc5_before=true" "fc5_view=true" "fc5_editable=true" "fc5_stored=false" "fc5_url=false" "37_fc5=pass" "recipe_exit=0"
run_step 37-fc7 ./scripts/verify-fail-conditions.sh 37-fc7
require_step_log 37-fc7 "fc7_edit=true" "fc7_title_focused=true" "37_fc7=pass" "recipe_exit=0"
run_step 37-fc8 ./scripts/verify-fail-conditions.sh 37-fc8
require_step_log 37-fc8 "fc8_switch_1280=true" "fc8_icon_1280=false" "fc8_1280_scroll=false" "fc8_switch_390=false" "fc8_icon_390=true" "fc8_390_scroll=false" "fc8_icon_to_edit=true" "fc8_390_edit_scroll=false" "fc8_icon_to_view=true" "fc8_390_back_scroll=false" "fc8_1280_back_scroll=false" "37_fc8=pass" "recipe_exit=0"
run_step 37-fc9 ./scripts/verify-fail-conditions.sh 37-fc9
require_step_log 37-fc9 "fc9_view_mode=1" "fc9_save_requests=0" "fc9_scene_unchanged=true" "fc9_reload_scene=true" "37_fc9=pass" "recipe_exit=0"
run_step 37-fc10 ./scripts/verify-fail-conditions.sh 37-fc10
require_step_log 37-fc10 "fc10_save_source_match=true" "fc10_mcp_source_match=true" "fc10_pages_source_match=true" "fc10_save_status=204" "fc10_update_status=200" "fc10_conflict_status=409" "fc10_forbidden_status=403" "fc10_save_new_deny=false" "fc10_update_new_deny=false" "fc10_update_body_match=true" "37_fc10=pass" "recipe_exit=0"
run_step 37-fc11 ./scripts/verify-fail-conditions.sh 37-fc11
require_step_log 37-fc11 "fc11_planted_pin_match=true" "fc11_planted_view_save=1" "fc11_planted_view_clone=1" "37_fc11_planted_exit=1" "fc11_planted_skip_pin_match=true" "fc11_planted_skip_preview=false" "37_fc11_planted_skip_exit=1" "fc11_view_preview_owned=true" "fc11_view_preview_foreign=true" "fc11_view_save=0" "fc11_view_clone=0" "fc11_edit_clone=1" "fc11_edit_save=1" "37_fc11_head_exit=0" "37_fc11=pass" "recipe_exit=0"
run_step 42-fc1 ./scripts/verify-fail-conditions.sh 42-fc1
require_step_log 42-fc1 "42_fc1_pin_match=true" "42_fc1_planted_timeout=true" "42_fc1_planted_exit=1" "42_fc1_head_timeout=false" "42_fc1_head_finished=10" "42_fc1_head_adopted=10" "42_fc1_head_exit=0" "42_fc1_planted_elapsed_ms=" "42_fc1_head_elapsed_ms=" "42_fc1=pass" "recipe_exit=0"
run_step 42-fc2 ./scripts/verify-fail-conditions.sh 42-fc2
require_step_log 42-fc2 "42_fc2_main_status=204" "42_fc2_main_error=none" "42_fc2_main_copied=false" "42_fc2_main_drawing_id=empty" "42_fc2_head_status=204" "42_fc2_head_error=none" "42_fc2_head_copied=false" "42_fc2_head_drawing_id=empty" "42_fc2_match=true" "42_fc2_refused=true" "42_fc2_main_exit=0" "42_fc2_head_exit=0" "42_fc2=pass" "recipe_exit=0"
run_step 42-fc3 ./scripts/verify-fail-conditions.sh 42-fc3
require_step_log 42-fc3 "42_fc3_pin_match=true" "42_fc3_planted_commit_timer_fresh=false" "42_fc3_planted_commit_detached_fresh=false" "42_fc3_planted_rollback_timer_fresh=false" "42_fc3_planted_rollback_detached_fresh=false" "42_fc3_planted_saw_uncommitted=true" "42_fc3_planted_exit=1" "42_fc3_head_commit_timer_fresh=true" "42_fc3_head_commit_timer_seen=0" "42_fc3_head_commit_detached_fresh=true" "42_fc3_head_commit_detached_seen=0" "42_fc3_head_rollback_timer_fresh=true" "42_fc3_head_rollback_timer_seen=0" "42_fc3_head_rollback_detached_fresh=true" "42_fc3_head_rollback_detached_seen=0" "42_fc3_head_saw_uncommitted=false" "42_fc3_head_fresh=true" "42_fc3_head_exit=0" "42_fc3=pass" "recipe_exit=0"
run_step fail10-3 ./scripts/verify-fail-conditions.sh 10-3
require_step_log fail10-3 "grandchild_status=400" "grandchild_error_clear=true" "parents_unchanged=true" "grandchild_rows_unchanged=true" "self_status=400" "self_error_clear=true" "self_unchanged=true" "self_rows_unchanged=true" "valid_status=200" "valid_parent_updated=true" "cycle_walk_within_500ms=true" "statement_timeout=false" "cycle_rows_unchanged=true"
run_step fail13 ./scripts/verify-fail-conditions.sh 13
require_step_log fail13 "sidebar_untitled=true" "sidebar_active=true" "sidebar_empty=false" "document_loads_after_create=0"
run_step fail20 ./scripts/verify-fail-conditions.sh 20
require_step_log fail20 "timestamp_text=true" "word_text=true" "invalid_day_text=true" "valid_chip=true" "blank_chip=false"
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
