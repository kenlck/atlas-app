#!/usr/bin/env bash
# Read-only check that the instance is the one this run should drive.
set -euo pipefail

BASE_URL="${BASE_URL:?BASE_URL is required}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)

python3 - "$BASE_URL" << 'PY'
import sys
from urllib.parse import urlparse

parsed = urlparse(sys.argv[1])
host = (parsed.hostname or "").lower()
if parsed.scheme != "http" or host not in {"localhost", "127.0.0.1", "::1"}:
    sys.stderr.write("refusing non-local BASE_URL\n")
    raise SystemExit(2)
PY

code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/sign-in")
echo "sign_in_status=$code"
echo "head_sha=$(git -C "$ROOT" rev-parse HEAD)"
if [[ -n "${ADMIN_API_SECRET:-}" ]]; then
  echo "admin_secret=set"
else
  echo "admin_secret=unset"
fi
if [[ -n "${ATLAS_CONTAINER:-}" ]]; then
  state=$(docker inspect -f '{{.State.Status}}' "$ATLAS_CONTAINER" 2>/dev/null || echo missing)
  echo "container=${ATLAS_CONTAINER} state=${state}"
fi
[[ "$code" == "200" ]]
