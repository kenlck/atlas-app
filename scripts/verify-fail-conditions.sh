#!/usr/bin/env bash
# Live recipes for issue #1. Never prints a secret, a password, or a database URL.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

BASE_URL="${BASE_URL:?BASE_URL is required}"
ADMIN_API_SECRET="${ADMIN_API_SECRET:-}"
ATLAS_IMAGE="${ATLAS_IMAGE:-atlas-app}"
ATLAS_CONTAINER="${ATLAS_CONTAINER:-}"
SHA=$(git rev-parse HEAD)

python3 - "$BASE_URL" << 'PY'
import sys
from urllib.parse import urlparse

parsed = urlparse(sys.argv[1])
host = (parsed.hostname or "").lower()
if parsed.scheme != "http" or host not in {"localhost", "127.0.0.1", "::1"}:
    sys.stderr.write("refusing non-local BASE_URL\n")
    raise SystemExit(2)
PY

if [[ -n "${DATABASE_URL:-}" ]]; then
  python3 - "$DATABASE_URL" << 'PY'
import sys
from urllib.parse import urlparse

parsed = urlparse(sys.argv[1])
host = (parsed.hostname or "").lower()
if parsed.scheme not in {"postgres", "postgresql"} or host not in {"localhost", "127.0.0.1", "::1"}:
    sys.stderr.write("refusing non-local DATABASE_URL\n")
    raise SystemExit(2)
PY
fi

echo "verify-fail-conditions BASE_URL set ADMIN_API_SECRET=$([[ -n "$ADMIN_API_SECRET" ]] && echo set || echo unset)"

run_recipe() {
  echo "START $(date -u +%Y-%m-%dT%H:%M:%SZ) sha=$SHA"
  set +e
  (
    set -euo pipefail
    "$@"
  )
  local code=$?
  set -e
  echo "recipe_exit=${code}"
  echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ) sha=$SHA"
  return "$code"
}

wait_http() {
  local url=$1
  local ready=false
  local _
  for _ in $(seq 1 40); do
    if curl -sf -o /dev/null "$url"; then
      ready=true
      break
    fi
    sleep 0.5
  done
  echo "listen=${ready} port_check=sign-in"
  [[ "$ready" == true ]]
}

write_app_env() {
  local dest=$1 port=$2 mode=$3
  python3 - "$dest" "$port" "$mode" << 'PY'
import os
import secrets
import sys
from pathlib import Path

dest, port, mode = sys.argv[1:]
base = f"http://127.0.0.1:{port}"
lines = [
    f"DATABASE_URL={os.environ['DATABASE_URL']}",
    f"BETTER_AUTH_SECRET={os.environ['BETTER_AUTH_SECRET']}",
    f"BETTER_AUTH_URL={base}",
    f"PORT={port}",
    "HOST=127.0.0.1",
]
if mode == "empty":
    lines.append("ADMIN_API_SECRET=")
elif mode == "short":
    lines.append("ADMIN_API_SECRET=short-secret")
elif mode == "boundary":
    lines.append("ADMIN_API_SECRET=" + ("b" * 31))
elif mode == "configured":
    lines.append(f"ADMIN_API_SECRET={secrets.token_urlsafe(32)}")
elif mode == "inherit":
    lines.append(f"ADMIN_API_SECRET={os.environ['ADMIN_API_SECRET']}")
Path(dest).write_text("\n".join(lines) + "\n")
os.chmod(dest, 0o600)
PY
}

boot_app() {
  local name=$1 port=$2 mode=$3
  local env_file=$4
  write_app_env "$env_file" "$port" "$mode"
  docker rm -f "$name" >/dev/null 2>&1 || true
  echo "CMD docker run -d --name $name --network host --env-file <unprinted> $ATLAS_IMAGE"
  docker run -d --name "$name" --network host --env-file "$env_file" "$ATLAS_IMAGE" >/dev/null
  wait_http "http://127.0.0.1:${port}/sign-in"
}

expect_empty_404() {
  local port=$1 label=$2
  local body
  body=$(mktemp)
  local code
  code=$(curl -sS -o "$body" -w '%{http_code}' -X POST "http://127.0.0.1:${port}/api/admin/reset-password" \
    -H 'content-type: application/json' -d '{"email":"nobody@example.com"}')
  local bytes
  bytes=$(wc -c < "$body" | tr -d ' ')
  rm -f "$body"
  echo "status_${label}=$code"
  echo "body_bytes_${label}=$bytes"
  [[ "$code" == "404" && "$bytes" == "0" ]]
}

recipe_1() {
  pnpm exec tsx scripts/http-evidence.ts fail1
}

recipe_2() {
  pnpm exec tsx scripts/http-evidence.ts fail2
}

recipe_3() {
  pnpm exec tsx scripts/fail3-playwright.ts
  pnpm exec tsx scripts/autosave-flush.ts
}

recipe_4() {
  pnpm exec tsx scripts/fail4-live.ts
}

expect_production_exit() {
  local name=$1 port=$2 mode=$3 env_file=$4 work=$5 label=$6
  write_app_env "$env_file" "$port" "$mode"
  docker rm -f "$name" >/dev/null 2>&1 || true
  echo "CMD docker run -d --name $name --network host --env-file <unprinted> $ATLAS_IMAGE"
  docker run -d --name "$name" --network host --env-file "$env_file" "$ATLAS_IMAGE" >/dev/null
  local status=running
  local _
  for _ in $(seq 1 40); do
    status=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo missing)
    if [[ "$status" != "running" && "$status" != "created" ]]; then
      break
    fi
    sleep 0.25
  done
  local code
  code=$(docker inspect -f '{{.State.ExitCode}}' "$name" 2>/dev/null || echo none)
  echo "status_${label}=$status"
  echo "exit_${label}=$code"
  docker logs "$name" >"$work/${label}.log" 2>&1 || true
  python3 - "$work/${label}.log" "$code" "$label" << 'PY'
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(errors="replace")
text = re.sub(r"postgres(?:ql)?://\S+", "[redacted-url]", text)
code, label = sys.argv[2], sys.argv[3]
print(text.rstrip())
named = "ADMIN_API_SECRET is required" in text
print(f"names_ADMIN_API_SECRET_{label}={str(named).lower()}")
if code in {"0", "none"} or not named:
    raise SystemExit(1)
PY
}

recipe_5a() {
  local work
  work=$(mktemp -d)
  chmod 700 "$work"
  trap "docker rm -f atlas-5a-unset atlas-5a-empty >/dev/null 2>&1 || true; rm -rf '$work'" EXIT
  expect_production_exit atlas-5a-unset 3411 unset "$work/unset.env" "$work" unset
  expect_production_exit atlas-5a-empty 3412 empty "$work/empty.env" "$work" empty
  docker rm -f atlas-5a-unset atlas-5a-empty >/dev/null 2>&1 || true
  rm -rf "$work"
  trap - EXIT
}

recipe_5e() {
  local work
  work=$(mktemp -d)
  chmod 700 "$work"
  trap "docker rm -f atlas-5e-short atlas-5e-boundary >/dev/null 2>&1 || true; rm -rf '$work'" EXIT
  boot_app atlas-5e-short 3413 short "$work/short.env"
  expect_empty_404 3413 short
  boot_app atlas-5e-boundary 3416 boundary "$work/boundary.env"
  expect_empty_404 3416 boundary
  docker rm -f atlas-5e-short atlas-5e-boundary >/dev/null 2>&1 || true
  rm -rf "$work"
  trap - EXIT
}

recipe_5b() {
  local work
  work=$(mktemp -d)
  chmod 700 "$work"
  trap "docker rm -f atlas-5b >/dev/null 2>&1 || true; rm -rf '$work'" EXIT
  boot_app atlas-5b 3414 configured "$work/app.env"
  local missing short long
  missing=$(curl -sS -o "$work/missing.body" -w '%{http_code}' -X POST "http://127.0.0.1:3414/api/admin/reset-password" \
    -H 'content-type: application/json' -d '{"email":"nobody@example.com"}')
  short=$(curl -sS -o "$work/short.body" -w '%{http_code}' -X POST "http://127.0.0.1:3414/api/admin/reset-password" \
    -H 'content-type: application/json' -H 'authorization: Bearer short' -d '{"email":"nobody@example.com"}')
  long=$(curl -sS -o "$work/long.body" -w '%{http_code}' -X POST "http://127.0.0.1:3414/api/admin/reset-password" \
    -H 'content-type: application/json' \
    -H 'authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    -d '{"email":"nobody@example.com"}')
  local match=false
  if cmp -s "$work/missing.body" "$work/short.body" && cmp -s "$work/short.body" "$work/long.body"; then
    match=true
  fi
  echo "missing_bearer_status=$missing"
  echo "short_bearer_status=$short"
  echo "long_bearer_status=$long"
  echo "bearer_bodies_match=$match"
  echo "missing_body=$(cat "$work/missing.body")"
  echo "constant_time_unit_test=tests/admin-reset.test.ts admin reset rejects a wrong secret, returns a temp password once, locks the user, and audits"
  echo "constant_time_live_timing=false"
  [[ "$missing" == "401" && "$short" == "401" && "$long" == "401" && "$match" == true ]]
  docker rm -f atlas-5b >/dev/null 2>&1 || true
  rm -rf "$work"
  trap - EXIT
}

grep_absent() {
  local work=$1 haystack=$2 suffix=$3
  local ok=0 pair label file
  if [[ ! -s "$haystack" ]]; then
    echo "${suffix}_present=false"
    return 1
  fi
  echo "${suffix}_present=true"
  for pair in \
    "secret_not_in_${suffix}:admin_secret" \
    "temp_not_in_${suffix}:temp_password" \
    "new_not_in_${suffix}:new_password" \
    "temp2_not_in_${suffix}:temp_password_2" \
    "supplied_not_in_${suffix}:supplied_password"
  do
    label="${pair%%:*}"
    file="$work/${pair#*:}"
    if [[ ! -f "$file" ]]; then
      case "$file" in
        *temp_password_2|*supplied_password) continue ;;
      esac
      echo "${label}=false"
      ok=1
      continue
    fi
    if [[ ! -s "$file" ]]; then
      echo "${label}=false"
      ok=1
      continue
    fi
    if grep -F -f "$file" -q "$haystack"; then
      echo "${label}=false"
      ok=1
    else
      echo "${label}=true"
    fi
  done
  return "$ok"
}

prepare_trace() {
  local work=$1
  if [[ -z "$ADMIN_API_SECRET" ]]; then
    echo "ADMIN_API_SECRET is required"
    return 1
  fi
  printf '%s' "$ADMIN_API_SECRET" > "$work/admin_secret"
  chmod 600 "$work/admin_secret"
}

recipe_5c() {
  local work
  work=$(mktemp -d)
  chmod 700 "$work"
  trap "docker rm -f atlas-5c >/dev/null 2>&1 || true; rm -rf '$work'" EXIT
  boot_app atlas-5c 3417 inherit "$work/app.env"
  BASE_URL="http://127.0.0.1:3417" pnpm exec tsx scripts/http-evidence.ts fail5c
  docker rm -f atlas-5c >/dev/null 2>&1 || true
  rm -rf "$work"
  trap - EXIT
}

recipe_5d() {
  local work
  work=$(mktemp -d)
  chmod 700 "$work"
  trap "docker rm -f atlas-5d >/dev/null 2>&1 || true; rm -rf '$work'" EXIT
  prepare_trace "$work"
  boot_app atlas-5d 3418 inherit "$work/app.env"
  VERIFY_TRACE_DIR="$work" BASE_URL="http://127.0.0.1:3418" pnpm exec tsx scripts/http-evidence.ts fail5d
  echo "CMD docker logs atlas-5d"
  docker logs atlas-5d > "$work/app.log" 2>&1
  echo "log_lines=$(wc -l < "$work/app.log" | tr -d ' ')"
  local logs_ok=0 audit_ok=0
  set +e
  grep_absent "$work" "$work/app.log" logs
  logs_ok=$?
  grep_absent "$work" "$work/audit_row" audit
  audit_ok=$?
  set -e
  docker rm -f atlas-5d >/dev/null 2>&1 || true
  rm -rf "$work"
  trap - EXIT
  [[ "$logs_ok" -eq 0 && "$audit_ok" -eq 0 ]]
}

recipe_5f() {
  local work
  work=$(mktemp -d)
  chmod 700 "$work"
  trap "rm -rf '$work'" EXIT
  prepare_trace "$work"
  VERIFY_TRACE_DIR="$work" pnpm exec tsx scripts/http-evidence.ts fail5f
  local audit_ok=0
  set +e
  grep_absent "$work" "$work/audit_row" audit
  audit_ok=$?
  set -e
  rm -rf "$work"
  trap - EXIT
  return "$audit_ok"
}

recipe_5g() {
  local work
  work=$(mktemp -d)
  chmod 700 "$work"
  trap "rm -rf '$work'" EXIT
  prepare_trace "$work"
  VERIFY_TRACE_DIR="$work" pnpm exec tsx scripts/http-evidence.ts fail5g
  local audit_ok=0
  set +e
  grep_absent "$work" "$work/audit_row" audit
  audit_ok=$?
  set -e
  rm -rf "$work"
  trap - EXIT
  return "$audit_ok"
}

recipe_forgot() {
  pnpm exec tsx scripts/forgot-password-note.ts
}

recipe_editor() {
  pnpm exec tsx scripts/editor-tables-dates.ts "$1"
}

recipe_space_error() {
  pnpm exec tsx scripts/space-error-actions.ts
}

recipe_design_lock() {
  local lint_code=0
  set +e
  node scripts/lint-tokens.mjs
  lint_code=$?
  set -e
  if [[ "$lint_code" -eq 0 ]]; then
    echo "tokens_result=pass"
  else
    echo "tokens_result=fail"
  fi
  local count
  count=$(find tests/visual/baselines -type f -name '*.png' | wc -l | tr -d ' ')
  echo "baseline_count=${count}"
  find tests/visual/baselines -type f -name '*.png' -printf '%f\n' | sort | while read -r name; do
    echo "baseline=${name}"
  done
  return "$lint_code"
}

recipe_3_5() {
  local names=(
    1280-table-default.png
    1280-table-tools.png
    1280-table-selection.png
    1280-table-resize.png
    1280-table-merged.png
    1280-table-wide.png
    390-table-wide.png
    1280-table-paste.png
    1280-date-chip.png
    1280-date-chip-focus.png
    1280-date-picker.png
    390-date-picker.png
    1280-table-reload.png
  )
  local missing=0
  local name bytes
  for name in "${names[@]}"; do
    if [[ ! -s "tests/visual/baselines/${name}" ]]; then
      echo "baseline_missing=${name}"
      missing=1
      continue
    fi
    bytes=$(wc -c < "tests/visual/baselines/${name}" | tr -d ' ')
    echo "baseline=${name} bytes=${bytes}"
  done
  echo "table_date_baselines_missing=${missing}"
  return "$missing"
}

recipe_5h() {
  local work
  work=$(mktemp -d)
  chmod 700 "$work"
  trap "docker rm -f atlas-5h >/dev/null 2>&1 || true; rm -rf '$work'" EXIT
  boot_app atlas-5h 3415 inherit "$work/app.env"
  BASE_URL="http://127.0.0.1:3415" pnpm exec tsx scripts/http-evidence.ts fail5h
  docker rm -f atlas-5h >/dev/null 2>&1 || true
  rm -rf "$work"
  trap - EXIT
}

recipe_6() {
  local work pg_port app_port
  work=$(mktemp -d)
  chmod 700 "$work"
  pg_port=35432
  app_port=3420
  trap "docker rm -f atlas-fail6-app atlas-fail6-pg >/dev/null 2>&1 || true; rm -rf '$work'" EXIT
  python3 - "$work" "$pg_port" "$app_port" << 'PY'
import json
import os
import secrets
import sys
from pathlib import Path

work = Path(sys.argv[1])
pg_port, app_port = sys.argv[2], sys.argv[3]
alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

def token(n: int) -> str:
    return "".join(secrets.choice(alphabet) for _ in range(n))

pg_password = token(24)
auth_secret = token(48)
admin_secret = token(48)
signup_password = token(24)
email = f"fail6.{os.urandom(4).hex()}@example.com"
base = f"http://127.0.0.1:{app_port}"
(work / "pg.env").write_text(
    "POSTGRES_USER=atlas\n"
    f"POSTGRES_PASSWORD={pg_password}\n"
    "POSTGRES_DB=atlas\n"
)
(work / "app.env").write_text(
    f"DATABASE_URL=postgres://atlas:{pg_password}@127.0.0.1:{pg_port}/atlas?sslmode=disable\n"
    "HOST=127.0.0.1\n"
    f"PORT={app_port}\n"
    f"BETTER_AUTH_SECRET={auth_secret}\n"
    f"BETTER_AUTH_URL={base}\n"
    f"ADMIN_API_SECRET={admin_secret}\n"
)
(work / "signup.json").write_text(json.dumps({"name": "Fail Six", "email": email, "password": signup_password}))
(work / "signup.curlrc").write_text(
    "silent\n"
    "show-error\n"
    'request = "POST"\n'
    f'url = "{base}/api/auth/sign-up/email"\n'
    'header = "content-type: application/json"\n'
    f'header = "origin: {base}"\n'
    f'data = "@{work / "signup.json"}"\n'
    f'output = "{work / "signup.body"}"\n'
    f'dump-header = "{work / "signup.headers"}"\n'
)
for path in (work / "pg.env", work / "app.env", work / "signup.json", work / "signup.curlrc"):
    os.chmod(path, 0o600)
PY
  echo "CMD docker run -d --name atlas-fail6-pg --env-file <unprinted> -p 127.0.0.1:${pg_port}:5432 postgres:16"
  local attempt
  for attempt in 1 2 3; do
    docker rm -f atlas-fail6-pg >/dev/null 2>&1 || true
    if docker run -d --name atlas-fail6-pg --env-file "$work/pg.env" -p "127.0.0.1:${pg_port}:5432" postgres:16 >/dev/null; then
      break
    fi
    if [[ "$attempt" -eq 3 ]]; then
      return 1
    fi
    sleep 1
  done
  # First boot logs "ready to accept connections" for the temporary init
  # server, then again for the real postmaster. Migrating on the first
  # ready hits ECONNRESET when that temporary server exits.
  local ready=false
  local _
  for _ in $(seq 1 60); do
    local ready_lines=0
    ready_lines=$(docker logs atlas-fail6-pg 2>&1 | grep -c "database system is ready to accept connections" || true)
    if [[ "${ready_lines}" -ge 2 ]] && docker exec atlas-fail6-pg pg_isready -q; then
      if command -v pg_isready >/dev/null 2>&1; then
        if pg_isready -q -h 127.0.0.1 -p "$pg_port"; then
          ready=true
          break
        fi
      else
        ready=true
        break
      fi
    fi
    sleep 1
  done
  echo "postgres_ready=$ready"
  echo "postgres_bind=127.0.0.1:${pg_port}"
  [[ "$ready" == true ]]
  echo "CMD docker run --rm --network host --env-file <unprinted> $ATLAS_IMAGE node migrate.mjs"
  set +e
  docker run --rm --network host --env-file "$work/app.env" "$ATLAS_IMAGE" node migrate.mjs >"$work/migrate.out" 2>&1
  local migrate_exit=$?
  set -e
  python3 - "$work/migrate.out" "$migrate_exit" << 'PY'
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(errors="replace")
text = re.sub(r"postgres(?:ql)?://\S+", "[redacted-url]", text)
print(text.rstrip())
print(f"migrate_exit={sys.argv[2]}")
if sys.argv[2] != "0" or "migrations applied" not in text:
    raise SystemExit(1)
print("migrate_result=migrations_applied")
PY
  echo "CMD docker run -d --name atlas-fail6-app --network host --env-file <unprinted> $ATLAS_IMAGE"
  docker run -d --name atlas-fail6-app --network host --env-file "$work/app.env" "$ATLAS_IMAGE" >/dev/null
  wait_http "http://127.0.0.1:${app_port}/sign-in"
  echo "CMD curl --config <unprinted>"
  curl --config "$work/signup.curlrc"
  python3 - "$work/signup.headers" "$work/signup.body" << 'PY'
import json
import re
import sys
from pathlib import Path

headers = Path(sys.argv[1]).read_text(errors="replace")
raw = Path(sys.argv[2]).read_text(errors="replace")
codes = [line.split()[1] for line in headers.splitlines() if line.startswith("HTTP/") and len(line.split()) >= 2]
status = codes[-1] if codes else "none"
print(f"signup_status={status}")
shown = re.sub(r'("token"\s*:\s*")[^"]+"', r'\1[redacted]"', raw)
shown = re.sub(r'("password"\s*:\s*")[^"]+"', r'\1[redacted]"', shown)
shown = re.sub(r"better-auth\.session_token=[^;\s]+", "better-auth.session_token=[redacted]", shown)
print(shown)
body = json.loads(raw)
user = body.get("user") or {}
print(f"user_id_len={len(user.get('id') or '')}")
print(f"mustChangePassword={user.get('mustChangePassword')}")
if status != "200" or not user.get("id") or user.get("mustChangePassword") is not False:
    raise SystemExit(1)
PY
  docker rm -f atlas-fail6-app atlas-fail6-pg >/dev/null 2>&1 || true
  rm -rf "$work"
  trap - EXIT
}

refuse_boot() {
  local missing=$1
  local server="$ROOT/.output/server/index.mjs"
  if [[ ! -f "$server" ]]; then
    echo "missing .output/server/index.mjs"
    return 1
  fi
  local work
  work=$(mktemp -d)
  chmod 700 "$work"
  local -a env_args=(
    NODE_ENV=production
    "DATABASE_URL=${DATABASE_URL:-${TEST_DATABASE_URL:?TEST_DATABASE_URL or DATABASE_URL must be set}}"
    BETTER_AUTH_URL=http://127.0.0.1:3997
    HOST=127.0.0.1
    PORT=3997
    BETTER_AUTH_TELEMETRY=0
  )
  if [[ "$missing" == "BETTER_AUTH_SECRET" ]]; then
    env_args+=(ADMIN_API_SECRET=dummy-admin-api-secret-32-characters)
  else
    env_args+=(BETTER_AUTH_SECRET=dummy-better-auth-secret-32-chars)
  fi
  echo "CMD env -u ${missing} NODE_ENV=production HOST=127.0.0.1 PORT=3997 node .output/server/index.mjs"
  set +e
  env -u "$missing" "${env_args[@]}" timeout 8 node "$server" >"$work/out" 2>&1
  local code=$?
  python3 - "$work/out" "$code" "$missing" << 'PY'
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(errors="replace")
text = re.sub(r"postgres(?:ql)?://\S+", "[redacted-url]", text)
code = int(sys.argv[2])
name = sys.argv[3]
print(text.rstrip())
print(f"exit_code={code}")
needle = f"{name} is required"
print(f"names_{name}={str(needle in text).lower()}")
dummies = (
    "dummy-admin-api-secret-32-characters",
    "dummy-better-auth-secret-32-chars",
)
leaked = any(item in text for item in dummies)
print(f"dummy_values_absent={str(not leaked).lower()}")
if code in (0, 124) or needle not in text or leaked or "[redacted-url]" in text:
    raise SystemExit(1)
PY
  local py=$?
  set -e
  rm -rf "$work"
  return "$py"
}

recipe_7() {
  refuse_boot BETTER_AUTH_SECRET
}

recipe_7a() {
  refuse_boot ADMIN_API_SECRET
}

recipe_8() {
  echo "CMD NODE_ENV=production TRUST_PROXY=1 pnpm exec tsx scripts/verify-client-ip.ts"
  NODE_ENV=production \
    DATABASE_URL="${DATABASE_URL:-${TEST_DATABASE_URL:?TEST_DATABASE_URL or DATABASE_URL must be set}}" \
    BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://127.0.0.1:3000}" \
    BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-dummy-better-auth-secret-32-chars}" \
    ADMIN_API_SECRET="${ADMIN_API_SECRET:-dummy-admin-api-secret-32-characters}" \
    TRUST_PROXY=1 \
    BETTER_AUTH_TELEMETRY=0 \
    pnpm exec tsx scripts/verify-client-ip.ts
}

recipe_9() {
  : "${DATABASE_URL:-${TEST_DATABASE_URL:?TEST_DATABASE_URL or DATABASE_URL must be set}}"
  echo "CMD pnpm exec tsx scripts/verify-fail-conditions.ts fail9"
  BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://127.0.0.1:3000}" \
    pnpm exec tsx scripts/verify-fail-conditions.ts fail9
}

recipe_9a() {
  : "${DATABASE_URL:-${TEST_DATABASE_URL:?TEST_DATABASE_URL or DATABASE_URL must be set}}"
  echo "CMD pnpm exec tsx scripts/verify-fail-conditions.ts fail9a"
  BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://127.0.0.1:3000}" \
    pnpm exec tsx scripts/verify-fail-conditions.ts fail9a
}

require_database_url() {
  : "${DATABASE_URL:-${TEST_DATABASE_URL:?TEST_DATABASE_URL or DATABASE_URL must be set}}"
  : "${BASE_URL:?BASE_URL is required}"
}

recipe_5_1() {
  require_database_url
  echo "CMD pnpm exec tsx scripts/calendar-fail.ts 5-1"
  pnpm exec tsx scripts/calendar-fail.ts 5-1
}

recipe_5_2() {
  require_database_url
  echo "CMD pnpm exec tsx scripts/calendar-fail.ts 5-2"
  pnpm exec tsx scripts/calendar-fail.ts 5-2
}

recipe_5_3() {
  require_database_url
  echo "CMD pnpm exec tsx scripts/calendar-fail.ts 5-3"
  pnpm exec tsx scripts/calendar-fail.ts 5-3
}

recipe_5_4() {
  require_database_url
  echo "CMD pnpm exec tsx scripts/calendar-fail.ts 5-4"
  pnpm exec tsx scripts/calendar-fail.ts 5-4
}

case "${1:-}" in
  1|fail1) run_recipe recipe_1 ;;
  2|fail2) run_recipe recipe_2 ;;
  3|fail3) run_recipe recipe_3 ;;
  4|fail4) run_recipe recipe_4 ;;
  5a) run_recipe recipe_5a ;;
  5e) run_recipe recipe_5e ;;
  5b) run_recipe recipe_5b ;;
  5c) run_recipe recipe_5c ;;
  5d) run_recipe recipe_5d ;;
  5f) run_recipe recipe_5f ;;
  5g) run_recipe recipe_5g ;;
  5h) run_recipe recipe_5h ;;
  forgot-password) run_recipe recipe_forgot ;;
  design-lock) run_recipe recipe_design_lock ;;
  3-1) run_recipe recipe_editor 3-1 ;;
  3-2) run_recipe recipe_editor 3-2 ;;
  3-3) run_recipe recipe_editor 3-3 ;;
  3-4) run_recipe recipe_editor 3-4 ;;
  3-5) run_recipe recipe_3_5 ;;
  space-error) run_recipe recipe_space_error ;;
  6|fail6) run_recipe recipe_6 ;;
  7) run_recipe recipe_7 ;;
  7a) run_recipe recipe_7a ;;
  8) run_recipe recipe_8 ;;
  9) run_recipe recipe_9 ;;
  9a) run_recipe recipe_9a ;;
  5-1) run_recipe recipe_5_1 ;;
  5-2) run_recipe recipe_5_2 ;;
  5-3) run_recipe recipe_5_3 ;;
  5-4) run_recipe recipe_5_4 ;;
  all)
    echo "START $(date -u +%Y-%m-%dT%H:%M:%SZ) sha=$SHA"
    echo "all runs in-process checks and vitest, which drops the public schema"
    pnpm exec tsx scripts/verify-fail-conditions.ts all
    pnpm exec vitest run tests/pages.test.ts tests/admin-reset.test.ts tests/auth-lock.test.ts --reporter=verbose
    echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ) sha=$SHA"
    ;;
  *)
    echo "usage: $0 [1|2|3|4|5a|5b|5c|5d|5e|5f|5g|5h|forgot-password|design-lock|3-1|3-2|3-3|3-4|3-5|space-error|6|7|7a|8|9|9a|5-1|5-2|5-3|5-4|all]" >&2
    exit 2
    ;;
esac
