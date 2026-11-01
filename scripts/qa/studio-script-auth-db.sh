#!/usr/bin/env bash
# USD 0. Disposable PostgreSQL (own data dir, unix socket, no TCP listen) for the studio-script
# authorization proposal. Does not read DATABASE_URL / SUPABASE_DB_URL and does not apply this
# proposal to any database except the cluster it just created. Not a production migration.
# Usage: bash scripts/qa/studio-script-auth-db.sh [workdir] [port]
set -euo pipefail
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
W=${1:-$(mktemp -d)}
P=${2:-55931}
PB=${PG_BIN:-$( (pg_config --bindir 2>/dev/null) || ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}
mkdir -p "$W/logs" "$W/run"
"$PB/initdb" -D "$W/pg" -U postgres --auth=trust >/dev/null
"$PB/pg_ctl" -D "$W/pg" -o "-p $P -k $W/run -c listen_addresses=''" -l "$W/logs/pg.log" -w start >/dev/null
trap '"$PB/pg_ctl" -D "$W/pg" -m fast stop >/dev/null 2>&1 || true' EXIT
PS="psql -h $W/run -p $P -U postgres -v ON_ERROR_STOP=1 -q"
$PS -d postgres -c "create database studio_script_auth"
echo "disposable cluster only ($("$PB/postgres" --version)); proposal is NOT applied anywhere else"
PGHOST=$W/run PGPORT=$P DB=studio_script_auth bash "$R/scripts/qa/studio-script-auth-postgres.sh"
