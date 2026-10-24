#!/usr/bin/env bash
# USD 0. Builds a DISPOSABLE PostgreSQL cluster (temp dir, own port, unix socket) from the repo migrations, then runs
# scripts/qa/spend-authorization-postgres.sh against it and stops the cluster. Never touches any other database.
# Usage: bash scripts/qa/spend-authorization-db.sh [workdir] [port] [test script (default: spend-authorization-postgres.sh)]
set -euo pipefail
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel); W=${1:-$(mktemp -d)}; P=${2:-55901}; T=${3:-$R/scripts/qa/spend-authorization-postgres.sh}
PB=${PG_BIN:-$( (pg_config --bindir 2>/dev/null) || ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}
mkdir -p "$W/logs" "$W/run"
"$PB/initdb" -D "$W/pg" -U postgres --auth=trust >/dev/null
"$PB/pg_ctl" -D "$W/pg" -o "-p $P -k $W/run -c listen_addresses=''" -l "$W/logs/pg.log" -w start >/dev/null
trap '"$PB/pg_ctl" -D "$W/pg" -m fast stop >/dev/null 2>&1 || true' EXIT
PS="psql -h $W/run -p $P -U postgres -v ON_ERROR_STOP=1 -q"
$PS -d postgres -c "create database atomivid_sa"
$PS -d atomivid_sa -f "$R/scripts/harness/e2e/infra/stubs.sql" >/dev/null
git -C "$R" cat-file -e 9dccd68c3b06bffab2dc91ab415de6c2a73062bd 2>/dev/null || git -C "$R" fetch -q origin 9dccd68c3b06bffab2dc91ab415de6c2a73062bd
git -C "$R" show 9dccd68c3b06bffab2dc91ab415de6c2a73062bd:supabase/migrations/0023_production_intelligence.sql > "$W/run/0023.sql"
echo "0b49d9a4752d19c1b6f6f24df6c3f0c6fbdbd39136a41832f5a6189aa7fa8131  $W/run/0023.sql" | sha256sum -c --quiet
KNOWN="20261011020000_pilot_scheduler.sql 20261014183400_finished_podcast_image_slot.sql" # same known local-only failures as setup.sh
d23=0; for f in $(ls "$R"/supabase/migrations/*.sql | sort); do b=$(basename "$f")
  if [ "$b" \> "0019_long_form_production_plan.sql" ] && [ $d23 = 0 ]; then $PS -d atomivid_sa -f "$W/run/0023.sql" > "$W/logs/mig-0023.log" 2>&1; d23=1; fi
  if ! $PS -d atomivid_sa -f "$f" > "$W/logs/mig-$b.log" 2>&1; then
    case " $KNOWN " in *" $b "*) echo "NOTICE known local-only migration skipped: $b";; *) echo "FAIL migration $b"; cat "$W/logs/mig-$b.log"; exit 1;; esac; fi
done
$PS -d atomivid_sa -f "$R/scripts/harness/e2e/infra/seed-config.sql" >/dev/null
echo "base schema: $(ls "$R"/supabase/migrations/*.sql | wc -l) migrations, postgres $("$PB/postgres" --version)"
PGHOST=$W/run PGPORT=$P DB=atomivid_sa bash "$T"
# P0 T-20261024-0724-chatgpt-02 (T10c DB layer, PR #201): exact project_id + authorization_ref + transaction_id on requeue.
# Integration of #201 (this line) with #199 (parameterized test script): runs with the default suite only.
if [ "$T" = "$R/scripts/qa/spend-authorization-postgres.sh" ]; then PGHOST=$W/run PGPORT=$P DB=atomivid_sa bash "$R/scripts/qa/resume-auth-ref-postgres.sh"; fi
