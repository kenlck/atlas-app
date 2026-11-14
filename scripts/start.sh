#!/bin/sh
# AUTO_MIGRATE=1 applies drizzle migrations, then starts the server only if
# that exits 0. Any other value, including unset, execs the server directly.
set -eu
cd "$(dirname "$0")/.."
if [ "${AUTO_MIGRATE:-}" = "1" ]; then
  if [ -f migrate.mjs ]; then
    node migrate.mjs
  else
    pnpm exec tsx scripts/migrate.ts
  fi
fi
exec node .output/server/index.mjs
