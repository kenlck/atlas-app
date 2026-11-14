#!/usr/bin/env bash
# Cases for opt-in AUTO_MIGRATE. Uses the local DATABASE_URL and ATLAS_IMAGE.
# Never prints a secret, a password, or a database URL.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

case="${1:?case is required}"
PINNED_SCHEMA=9bc889a29d1aa3bd2e34b6187b0ce5e09c171a91
work=$(mktemp -d)
container_names=
db_names=
printed=false

cleanup() {
  local status=$?
  local name db
  set +e
  for name in ${container_names:-}; do
    docker rm -f "$name" >/dev/null 2>&1
  done
  for db in ${db_names:-}; do
    python3 - "$db" << 'PY'
import os, re, subprocess, sys
from urllib.parse import urlsplit, urlunsplit

db = sys.argv[1]
if not re.fullmatch(r"[a-z][a-z0-9_]{0,40}", db):
    raise SystemExit(0)
base = os.environ.get("DATABASE_URL") or ""
parts = urlsplit(base)
url = urlunsplit((parts.scheme, parts.netloc, parts.path or "/postgres", parts.query, ""))
subprocess.run(
    ["psql", url, "-v", "ON_ERROR_STOP=1", "-q", "-c", f'DROP DATABASE IF EXISTS "{db}" WITH (FORCE)'],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
PY
  done
  rm -rf "$work"
  if [[ "$printed" != true ]]; then
    echo "auto_migrate_${case} result=fail"
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ -z "${ATLAS_IMAGE:-}" ]]; then
  echo "atlas_image=missing"
  exit 1
fi
if [[ -z "${BETTER_AUTH_SECRET:-}" || -z "${ADMIN_API_SECRET:-}" ]]; then
  echo "auth_env=missing"
  exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "psql=missing"
  exit 1
fi
pnpm exec tsx scripts/assert-local-database.ts --require

pick_port() {
  local port attempt avoid=${1:-}
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
    if [[ "$port" != "3000" && "$port" != "5432" && "$port" != "$avoid" ]]; then
      echo "$port"
      return 0
    fi
  done
  echo "no free port" >&2
  return 1
}

db_name() {
  echo "am_${1}_$$_${RANDOM}"
}

create_db() {
  local db=$1
  python3 - "$db" << 'PY'
import os, re, subprocess, sys
from urllib.parse import urlsplit, urlunsplit

db = sys.argv[1]
if not re.fullmatch(r"[a-z][a-z0-9_]{0,40}", db):
    sys.stderr.write("bad database name\n")
    raise SystemExit(1)
base = os.environ["DATABASE_URL"]
parts = urlsplit(base)
url = urlunsplit((parts.scheme, parts.netloc, parts.path or "/postgres", parts.query, ""))
proc = subprocess.run(
    ["psql", url, "-v", "ON_ERROR_STOP=1", "-q", "-c", f"CREATE DATABASE {db}"],
    capture_output=True,
    text=True,
)
if proc.returncode != 0:
    err = re.sub(r"postgres(?:ql)?://\S+", "[redacted-url]", proc.stderr or "")
    sys.stderr.write(err[-400:])
    raise SystemExit(proc.returncode)
PY
  db_names="${db_names:+$db_names }$db"
}

write_env() {
  local dest=$1 db=$2 port=$3 auto=$4
  python3 - "$dest" "$db" "$port" "$auto" << 'PY'
import os, re, sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

dest, db, port, auto = sys.argv[1:]
if not re.fullmatch(r"[a-z][a-z0-9_]{0,40}", db):
    raise SystemExit("bad database name")
parts = urlsplit(os.environ["DATABASE_URL"])
url = urlunsplit((parts.scheme, parts.netloc, "/" + db, parts.query, ""))
lines = [
    f"DATABASE_URL={url}",
    "HOST=127.0.0.1",
    f"PORT={port}",
    f"BETTER_AUTH_SECRET={os.environ['BETTER_AUTH_SECRET']}",
    f"BETTER_AUTH_URL=http://127.0.0.1:{port}",
    f"ADMIN_API_SECRET={os.environ['ADMIN_API_SECRET']}",
]
if auto == "1":
    lines.append("AUTO_MIGRATE=1")
Path(dest).write_text("\n".join(lines) + "\n")
os.chmod(dest, 0o600)
PY
}

sql_scalar() {
  local db=$1 query=$2
  python3 - "$db" "$query" << 'PY'
import os, re, subprocess, sys
from urllib.parse import urlsplit, urlunsplit

db, query = sys.argv[1], sys.argv[2]
if not re.fullmatch(r"[a-z][a-z0-9_]{0,40}", db):
    sys.stderr.write("bad database name\n")
    raise SystemExit(1)
parts = urlsplit(os.environ["DATABASE_URL"])
url = urlunsplit((parts.scheme, parts.netloc, "/" + db, parts.query, ""))
proc = subprocess.run(
    ["psql", url, "-v", "ON_ERROR_STOP=1", "-tA", "-c", query],
    capture_output=True,
    text=True,
)
if proc.returncode != 0:
    err = re.sub(r"postgres(?:ql)?://\S+", "[redacted-url]", proc.stderr or "")
    sys.stderr.write(err[-400:])
    raise SystemExit(proc.returncode)
print(proc.stdout.strip())
PY
}

journal_entries() {
  python3 -c 'import json; print(len(json.load(open("drizzle/meta/_journal.json"))["entries"]))'
}

start_app() {
  local name=$1 env=$2
  shift 2
  container_names="${container_names:+$container_names }$name"
  docker rm -f "$name" >/dev/null 2>&1 || true
  echo "CMD docker run -d --name ${name} --network host --env-file <unprinted> ${ATLAS_IMAGE}"
  docker run -d --name "$name" --network host --env-file "$env" "$@" "$ATLAS_IMAGE" >/dev/null
}

wait_http() {
  local port=$1
  local attempt code=000
  for attempt in $(seq 1 90); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${port}/healthcheck" || true)
    if [[ "$code" == "200" ]]; then
      echo "http_code=200"
      return 0
    fi
    sleep 0.5
  done
  echo "http_code=${code}"
  return 1
}

container_exit() {
  docker inspect -f '{{.State.ExitCode}}' "$1"
}

container_running() {
  docker inspect -f '{{.State.Running}}' "$1"
}

migration_rows() {
  sql_scalar "$1" "select count(*) from drizzle.__drizzle_migrations"
}

rows_distinct() {
  sql_scalar "$1" "select count(distinct hash) from drizzle.__drizzle_migrations"
}

pass() {
  printed=true
  echo "auto_migrate_${case} result=pass $*"
  exit 0
}

fail() {
  printed=true
  echo "auto_migrate_${case} result=fail $*"
  exit 1
}

case "$case" in
  a)
    db=$(db_name a)
    port=$(pick_port)
    create_db "$db"
    env="$work/a.env"
    write_env "$env" "$db" "$port" 1
    name="atlas-am-a-$$"
    start_app "$name" "$env"
    http_ok=false
    if wait_http "$port"; then
      http_ok=true
    fi
    exit_code=$(container_exit "$name")
    running=$(container_running "$name")
    journal=$(journal_entries)
    rows=$(migration_rows "$db")
    distinct=$(rows_distinct "$db")
    user_table=$(sql_scalar "$db" "select count(*) from information_schema.tables where table_schema = 'public' and table_name = 'user'")
    echo "exit_code=${exit_code}"
    echo "server_running=${running}"
    echo "migration_rows=${rows}"
    echo "distinct_rows=${distinct}"
    echo "journal_entries=${journal}"
    echo "user_rows=${user_table}"
    match=false
    if [[ "$rows" == "$journal" && "$distinct" == "$journal" && "$journal" != "0" ]]; then
      match=true
    fi
    echo "rows_match_journal=${match}"
    user_ok=false
    if [[ "$user_table" == "1" ]]; then
      user_ok=true
    fi
    echo "user_table=${user_ok}"
    if [[ "$http_ok" == true && "$exit_code" == "0" && "$running" == "true" && "$match" == true && "$user_ok" == true ]]; then
      pass "exit_code=${exit_code} http_code=200 rows_match_journal=true user_table=true"
    fi
    fail "exit_code=${exit_code} http_ok=${http_ok} rows_match_journal=${match} user_table=${user_ok}"
    ;;
  b)
    db=$(db_name b)
    port=$(pick_port)
    create_db "$db"
    partial="$work/partial"
    mkdir -p "$partial"
    git archive "$PINNED_SCHEMA" drizzle | tar -x -C "$partial"
    partial_entries=$(python3 - "$partial/drizzle" << 'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
journal_path = root / "meta" / "_journal.json"
journal = json.loads(journal_path.read_text())
if len(journal["entries"]) < 2:
    raise SystemExit("pinned journal is too short")
last = journal["entries"].pop()
sql_path = root / f"{last['tag']}.sql"
sql_path.unlink()
journal_path.write_text(json.dumps(journal, indent=2) + "\n")
print(len(journal["entries"]))
PY
)
    env="$work/b.env"
    write_env "$env" "$db" "$port" 1
    echo "CMD docker run --rm --network host --env-file <unprinted> ${ATLAS_IMAGE} node migrate.mjs"
    set +e
    docker run --rm --network host --env-file "$env" -v "$partial/drizzle:/app/drizzle:ro" "$ATLAS_IMAGE" node migrate.mjs >"$work/partial.out" 2>&1
    partial_exit=$?
    set -e
    echo "partial_exit=${partial_exit}"
    rows_before=$(migration_rows "$db")
    echo "rows_before=${rows_before}"
    echo "partial_entries=${partial_entries}"
    name="atlas-am-b-$$"
    start_app "$name" "$env"
    http_ok=false
    if wait_http "$port"; then
      http_ok=true
    fi
    forward_exit=$(container_exit "$name")
    running=$(container_running "$name")
    journal=$(journal_entries)
    rows_after=$(migration_rows "$db")
    distinct=$(rows_distinct "$db")
    echo "forward_exit=${forward_exit}"
    echo "server_running=${running}"
    echo "rows_after=${rows_after}"
    echo "distinct_rows=${distinct}"
    echo "journal_entries=${journal}"
    match=false
    moved=false
    if [[ "$rows_after" == "$journal" && "$distinct" == "$journal" ]]; then
      match=true
    fi
    if [[ "$rows_before" == "$partial_entries" && "$rows_after" -gt "$rows_before" ]]; then
      moved=true
    fi
    echo "rows_match_journal=${match}"
    echo "moved_forward=${moved}"
    if [[ "$partial_exit" == "0" && "$http_ok" == true && "$forward_exit" == "0" && "$running" == "true" && "$match" == true && "$moved" == true ]]; then
      pass "partial_exit=0 forward_exit=0 http_code=200 moved_forward=true rows_match_journal=true"
    fi
    fail "partial_exit=${partial_exit} forward_exit=${forward_exit} http_ok=${http_ok} moved_forward=${moved} rows_match_journal=${match}"
    ;;
  c)
    db=$(db_name c)
    port=$(pick_port)
    create_db "$db"
    env="$work/c.env"
    write_env "$env" "$db" "$port" 1
    first="atlas-am-c1-$$"
    start_app "$first" "$env"
    first_http=false
    if wait_http "$port"; then
      first_http=true
    fi
    first_exit=$(container_exit "$first")
    first_running=$(container_running "$first")
    journal=$(journal_entries)
    rows_first=$(migration_rows "$db")
    echo "first_exit=${first_exit}"
    echo "first_running=${first_running}"
    echo "rows_after_first=${rows_first}"
    echo "journal_entries=${journal}"
    docker rm -f "$first" >/dev/null 2>&1 || true
    second="atlas-am-c2-$$"
    start_app "$second" "$env"
    second_http=false
    if wait_http "$port"; then
      second_http=true
    fi
    second_exit=$(container_exit "$second")
    second_running=$(container_running "$second")
    rows_second=$(migration_rows "$db")
    distinct=$(rows_distinct "$db")
    echo "second_exit=${second_exit}"
    echo "server_running=${second_running}"
    echo "rows_after_second=${rows_second}"
    echo "distinct_rows=${distinct}"
    unchanged=false
    if [[ "$rows_first" == "$journal" && "$rows_second" == "$rows_first" && "$distinct" == "$journal" ]]; then
      unchanged=true
    fi
    echo "rows_unchanged=${unchanged}"
    if [[ "$first_http" == true && "$first_exit" == "0" && "$first_running" == "true" && "$second_http" == true && "$second_exit" == "0" && "$second_running" == "true" && "$unchanged" == true ]]; then
      pass "first_exit=0 second_exit=0 http_code=200 rows_unchanged=true"
    fi
    fail "first_exit=${first_exit} second_exit=${second_exit} first_http=${first_http} second_http=${second_http} rows_unchanged=${unchanged}"
    ;;
  d)
    db=$(db_name d)
    port1=$(pick_port)
    port2=$(pick_port "$port1")
    create_db "$db"
    slow="$work/slow"
    mkdir -p "$slow"
    cp -a drizzle "$slow/drizzle"
    python3 - "$slow/drizzle/0000_init.sql" << 'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
path.write_text("SELECT pg_sleep(5);\n--> statement-breakpoint\n" + path.read_text())
PY
    env1="$work/d1.env"
    env2="$work/d2.env"
    write_env "$env1" "$db" "$port1" 1
    write_env "$env2" "$db" "$port2" 1
    read -r high low < <(python3 - << 'PY'
import re
text = open("scripts/migrate.ts").read()
match = re.search(r"MIGRATION_LOCK_KEY = '(\d+)'", text)
if not match:
    raise SystemExit("lock key missing")
key = int(match.group(1))
print((key >> 32) & 0xFFFFFFFF, key & 0xFFFFFFFF)
PY
)
    first="atlas-am-d1-$$"
    second="atlas-am-d2-$$"
    start_app "$first" "$env1" -v "$slow/drizzle:/app/drizzle:ro"
    lock_held=false
    attempt=
    for attempt in $(seq 1 40); do
      held=$(sql_scalar "$db" "select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory' and l.granted and l.objsubid = 1 and l.classid = ${high} and l.objid = ${low} and a.datname = '${db}'" || echo fail)
      if [[ "$held" =~ ^[1-9][0-9]*$ ]]; then
        lock_held=true
        break
      fi
      sleep 0.25
    done
    echo "advisory_lock_held=${lock_held}"
    start_app "$second" "$env2" -v "$slow/drizzle:/app/drizzle:ro"
    first_http=false
    second_http=false
    if wait_http "$port1"; then
      first_http=true
    fi
    if wait_http "$port2"; then
      second_http=true
    fi
    first_exit=$(container_exit "$first")
    second_exit=$(container_exit "$second")
    first_running=$(container_running "$first")
    second_running=$(container_running "$second")
    first_failed=$(docker logs "$first" 2>&1 | grep -c "migration failed" || true)
    second_failed=$(docker logs "$second" 2>&1 | grep -c "migration failed" || true)
    journal=$(journal_entries)
    rows=$(migration_rows "$db")
    distinct=$(rows_distinct "$db")
    echo "first_exit=${first_exit}"
    echo "second_exit=${second_exit}"
    echo "first_running=${first_running}"
    echo "second_running=${second_running}"
    echo "first_failed=${first_failed}"
    echo "second_failed=${second_failed}"
    echo "migration_rows=${rows}"
    echo "distinct_rows=${distinct}"
    echo "journal_entries=${journal}"
    match=false
    if [[ "$rows" == "$journal" && "$distinct" == "$journal" && "$journal" != "0" ]]; then
      match=true
    fi
    echo "rows_match_journal=${match}"
    if [[ "$lock_held" == true && "$first_http" == true && "$second_http" == true && "$first_exit" == "0" && "$second_exit" == "0" && "$first_running" == "true" && "$second_running" == "true" && "$first_failed" == "0" && "$second_failed" == "0" && "$match" == true ]]; then
      pass "first_exit=0 second_exit=0 advisory_lock_held=true rows_match_journal=true"
    fi
    fail "advisory_lock_held=${lock_held} first_exit=${first_exit} second_exit=${second_exit} first_http=${first_http} second_http=${second_http} rows_match_journal=${match}"
    ;;
  e)
    db=$(db_name e)
    port=$(pick_port)
    create_db "$db"
    bad="$work/bad"
    mkdir -p "$bad"
    cp -a drizzle "$bad/drizzle"
    python3 - "$bad/drizzle" << 'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
journal_path = root / "meta" / "_journal.json"
journal = json.loads(journal_path.read_text())
entry = {
    "idx": len(journal["entries"]),
    "version": "7",
    "when": 1893456000000,
    "tag": "0009_bad",
    "breakpoints": True,
}
journal["entries"].append(entry)
journal_path.write_text(json.dumps(journal, indent=2) + "\n")
(root / "0009_bad.sql").write_text("SELECT 1 FROM atlas_auto_migrate_missing_relation;\n")
PY
    env="$work/e.env"
    write_env "$env" "$db" "$port" 1
    name="atlas-am-e-$$"
    start_app "$name" "$env" -v "$bad/drizzle:/app/drizzle:ro"
    port_open=false
    attempt=
    for attempt in $(seq 1 90); do
      if python3 -c 'import socket,sys; s=socket.socket(); s.settimeout(0.2); r=s.connect_ex(("127.0.0.1", int(sys.argv[1]))); s.close(); raise SystemExit(0 if r==0 else 1)' "$port"; then
        port_open=true
      fi
      running=$(container_running "$name" || echo missing)
      if [[ "$running" != "true" ]]; then
        break
      fi
      sleep 0.25
    done
    exit_code=$(container_exit "$name")
    running=$(container_running "$name" || echo missing)
    failed=$(docker logs "$name" 2>&1 | grep -c "migration failed" || true)
    nonzero=false
    if [[ "$exit_code" != "0" ]]; then
      nonzero=true
    fi
    server_started=false
    if [[ "$running" == "true" || "$port_open" == true ]]; then
      server_started=true
    fi
    echo "exit_code=${exit_code}"
    echo "exit_code_nonzero=${nonzero}"
    echo "port_open=${port_open}"
    echo "server_running=${running}"
    echo "server_started=${server_started}"
    echo "migration_failed_lines=${failed}"
    if [[ "$nonzero" == true && "$port_open" == false && "$server_started" == false && "$failed" != "0" ]]; then
      pass "exit_code=${exit_code} exit_code_nonzero=true port_open=false server_started=false"
    fi
    fail "exit_code=${exit_code} port_open=${port_open} server_started=${server_started} migration_failed_lines=${failed}"
    ;;
  f)
    db=$(db_name f)
    port=$(pick_port)
    create_db "$db"
    env="$work/f.env"
    write_env "$env" "$db" "$port" 0
    name="atlas-am-f-$$"
    start_app "$name" "$env"
    http_ok=false
    if wait_http "$port"; then
      http_ok=true
    fi
    exit_code=$(container_exit "$name")
    running=$(container_running "$name")
    objects=$(sql_scalar "$db" "select count(*) from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')")
    cmdline=$(docker exec "$name" sh -c 'tr "\0" " " < /proc/1/cmdline' | sed 's/[[:space:]]*$//')
    logged=$(docker logs "$name" 2>&1 | grep -c "migrations applied" || true)
    migrate_logged=true
    if [[ "$logged" == "0" ]]; then
      migrate_logged=false
    fi
    echo "exit_code=${exit_code}"
    echo "server_running=${running}"
    echo "schema_objects=${objects}"
    echo "cmdline=${cmdline}"
    echo "migrate_logged=${migrate_logged}"
    if [[ "$http_ok" == true && "$exit_code" == "0" && "$running" == "true" && "$objects" == "0" && "$cmdline" == "node .output/server/index.mjs" && "$migrate_logged" == false ]]; then
      pass "exit_code=0 http_code=200 schema_objects=0 cmdline=node .output/server/index.mjs migrate_logged=false"
    fi
    fail "exit_code=${exit_code} http_ok=${http_ok} schema_objects=${objects} cmdline=${cmdline} migrate_logged=${migrate_logged}"
    ;;
  *)
    echo "usage: $0 a|b|c|d|e|f" >&2
    exit 2
    ;;
esac
