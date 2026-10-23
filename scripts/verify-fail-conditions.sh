#!/usr/bin/env bash
# Recipes for issue #1 fail conditions. Credentials and secrets come from env.
# Never prints DATABASE_URL, ADMIN_API_SECRET, or passwords.
set -euo pipefail

BASE_URL="${BASE_URL:?BASE_URL is required}"
VERIFY_EMAIL="${VERIFY_EMAIL:-}"
VERIFY_PASSWORD="${VERIFY_PASSWORD:-}"
ADMIN_API_SECRET="${ADMIN_API_SECRET:-}"

redact() {
  sed -E \
    -e 's/better-auth\.session_token=[^;]+/better-auth.session_token=[redacted]/g' \
    -e 's/("temporaryPassword":")[^"]+"/\1[redacted]"/g' \
    -e 's/(Authorization: Bearer )[^[:space:]]+/\1[redacted]/g' \
    -e 's/(password=)[^&[:space:]]+/\1[redacted]/g'
}

status_of() {
  curl -sS -o /tmp/atlas-verify-body -D /tmp/atlas-verify-headers -w '%{http_code}' "$@"
}

echo "verify-fail-conditions BASE_URL set ADMIN_API_SECRET=$([[ -n "$ADMIN_API_SECRET" ]] && echo set || echo unset)"

case "${1:-all}" in
  1|fail1)
    echo "== Fail 1: B cannot open, save, or list A's page (404) =="
    echo "BASE_URL=\"\$BASE_URL\" pnpm exec tsx scripts/http-evidence.ts fail1"
    pnpm exec tsx scripts/http-evidence.ts fail1
    ;;
  2|fail2)
    echo "== Fail 2: signed-out page 307, page API and server function 401 =="
    echo "BASE_URL=\"\$BASE_URL\" pnpm exec tsx scripts/http-evidence.ts fail2"
    pnpm exec tsx scripts/http-evidence.ts fail2
    ;;
  3|fail3)
    echo "== Fail 3: type, reload, exact match; save 500 keeps text; mid-debounce flush =="
    echo "BASE_URL=\"\$BASE_URL\" pnpm exec tsx scripts/fail3-playwright.ts"
    pnpm exec tsx scripts/fail3-playwright.ts
    echo "BASE_URL=\"\$BASE_URL\" pnpm autosave-flush"
    pnpm autosave-flush
    ;;
  4|fail4)
    echo "== Fail 4: cycle move 400, archive hides children, concurrent inverse moves =="
    echo "pnpm exec vitest run tests/pages.test.ts --reporter=verbose"
    pnpm exec vitest run tests/pages.test.ts --reporter=verbose
    ;;
  5e)
    echo "== Fail 5e: unset or short ADMIN_API_SECRET returns 404 =="
    echo "curl -sS -D - -o /dev/null -X POST \$BASE_URL/api/admin/reset-password -H 'content-type: application/json' -d '{\"email\":\"nobody@example.com\"}'"
    # This recipe is meant to run against a process started without ADMIN_API_SECRET.
    code=$(status_of -X POST "$BASE_URL/api/admin/reset-password" -H 'content-type: application/json' -d '{"email":"nobody@example.com"}')
    echo "status=$code"
    redact < /tmp/atlas-verify-headers
    ;;
  5f|5g)
    echo "== Fail 5f/5g: reset row diff, locked 403, update-user 403, change-password, sign-out =="
    echo "BASE_URL=\"\$BASE_URL\" ADMIN_API_SECRET=\"\$ADMIN_API_SECRET\" pnpm exec tsx scripts/http-evidence.ts fail5"
    pnpm exec tsx scripts/http-evidence.ts fail5
    ;;
  5h)
    echo "== Fail 5h: rotating X-Forwarded-For still 429 =="
    echo "BASE_URL=\"\$BASE_URL\" ADMIN_API_SECRET=\"\$ADMIN_API_SECRET\" pnpm exec tsx scripts/http-evidence.ts fail5h"
    pnpm exec tsx scripts/http-evidence.ts fail5h
    ;;
  6|fail6)
    echo "== Fail 6: documented migrate + docker run env-only + sign-up =="
    echo "docker run --rm -e DATABASE_URL atlas-app node migrate.mjs"
    echo "docker run --rm -p 3000:3000 -e DATABASE_URL -e BETTER_AUTH_SECRET -e BETTER_AUTH_URL -e ADMIN_API_SECRET atlas-app"
    echo "(run those with env vars in the shell; this script does not print them)"
    ;;
  all)
    pnpm exec tsx scripts/verify-fail-conditions.ts all
    pnpm exec vitest run tests/pages.test.ts tests/admin-reset.test.ts tests/auth-lock.test.ts --reporter=verbose
    ;;
  *)
    echo "usage: $0 [all|1|2|3|4|5e|5f|5g|5h|6]" >&2
    exit 2
    ;;
esac
