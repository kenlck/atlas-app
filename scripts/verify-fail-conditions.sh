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

recipe_5e() {
  local work
  work=$(mktemp -d)
  chmod 700 "$work"
  trap "docker rm -f atlas-5e-unset atlas-5e-empty atlas-5e-short >/dev/null 2>&1 || true; rm -rf '$work'" EXIT
  boot_app atlas-5e-unset 3411 unset "$work/unset.env"
  expect_empty_404 3411 unset
  boot_app atlas-5e-empty 3412 empty "$work/empty.env"
  expect_empty_404 3412 empty
  boot_app atlas-5e-short 3413 short "$work/short.env"
  expect_empty_404 3413 short
  docker rm -f atlas-5e-unset atlas-5e-empty atlas-5e-short >/dev/null 2>&1 || true
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
  [[ "$missing" == "401" && "$short" == "401" && "$long" == "401" && "$match" == true ]]
  docker rm -f atlas-5b >/dev/null 2>&1 || true
  rm -rf "$work"
  trap - EXIT
}

recipe_5f() {
  local work
  work=$(mktemp -d)
  chmod 700 "$work"
  trap "rm -rf '$work'" EXIT
  if [[ -z "$ATLAS_CONTAINER" ]]; then
    echo "ATLAS_CONTAINER is required so the log grep can read the app container"
    return 1
  fi
  printf '%s' "$ADMIN_API_SECRET" > "$work/admin_secret"
  chmod 600 "$work/admin_secret"
  VERIFY_TRACE_DIR="$work" pnpm exec tsx scripts/http-evidence.ts fail5
  echo "CMD docker logs $ATLAS_CONTAINER"
  docker logs "$ATLAS_CONTAINER" > "$work/app.log" 2>&1
  echo "log_lines=$(wc -l < "$work/app.log" | tr -d ' ')"
  local label file ok=0
  for label in secret_not_in_logs:admin_secret temp_not_in_logs:temp_password new_not_in_logs:new_password; do
    file="$work/${label#*:}"
    label="${label%%:*}"
    if [[ ! -s "$file" ]]; then
      echo "${label}=false"
      ok=1
      continue
    fi
    if grep -F -f "$file" -q "$work/app.log"; then
      echo "${label}=false"
      ok=1
    else
      echo "${label}=true"
    fi
  done
  rm -rf "$work"
  trap - EXIT
  return "$ok"
}

recipe_5g() {
  pnpm exec tsx scripts/http-evidence.ts fail5
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
    f"DATABASE_URL=postgres://atlas:{pg_password}@host.docker.internal:{pg_port}/atlas?sslmode=disable\n"
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
  echo "CMD docker run -d --name atlas-fail6-pg --env-file <unprinted> -p ${pg_port}:5432 postgres:16"
  docker run -d --name atlas-fail6-pg --env-file "$work/pg.env" -p "${pg_port}:5432" postgres:16 >/dev/null
  local ready=false
  local _
  for _ in $(seq 1 40); do
    if docker exec atlas-fail6-pg pg_isready -q; then
      ready=true
      break
    fi
    sleep 1
  done
  echo "postgres_ready=$ready"
  [[ "$ready" == true ]]
  echo "CMD docker run --rm --add-host=host.docker.internal:host-gateway -e DATABASE_URL $ATLAS_IMAGE node migrate.mjs"
  set +e
  docker run --rm --add-host=host.docker.internal:host-gateway --env-file "$work/app.env" "$ATLAS_IMAGE" node migrate.mjs >"$work/migrate.out" 2>&1
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
  echo "CMD docker run -d --name atlas-fail6-app --add-host=host.docker.internal:host-gateway -p 127.0.0.1:${app_port}:3000 -e DATABASE_URL -e BETTER_AUTH_SECRET -e BETTER_AUTH_URL -e ADMIN_API_SECRET $ATLAS_IMAGE"
  docker run -d --name atlas-fail6-app --add-host=host.docker.internal:host-gateway \
    -p "127.0.0.1:${app_port}:3000" --env-file "$work/app.env" "$ATLAS_IMAGE" >/dev/null
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

case "${1:-}" in
  1|fail1) run_recipe recipe_1 ;;
  2|fail2) run_recipe recipe_2 ;;
  3|fail3) run_recipe recipe_3 ;;
  4|fail4) run_recipe recipe_4 ;;
  5e) run_recipe recipe_5e ;;
  5b) run_recipe recipe_5b ;;
  5f) run_recipe recipe_5f ;;
  5g) run_recipe recipe_5g ;;
  5h) run_recipe recipe_5h ;;
  6|fail6) run_recipe recipe_6 ;;
  all)
    echo "START $(date -u +%Y-%m-%dT%H:%M:%SZ) sha=$SHA"
    echo "all runs in-process checks and vitest, which drops the public schema"
    pnpm exec tsx scripts/verify-fail-conditions.ts all
    pnpm exec vitest run tests/pages.test.ts tests/admin-reset.test.ts tests/auth-lock.test.ts --reporter=verbose
    echo "END $(date -u +%Y-%m-%dT%H:%M:%SZ) sha=$SHA"
    ;;
  *)
    echo "usage: $0 [1|2|3|4|5e|5b|5f|5g|5h|6|all]" >&2
    exit 2
    ;;
esac
