#!/usr/bin/env bash
# USD 0. Production is ONLY read (explicit READ ONLY transaction probe; pg_dump snapshot); everything else runs on a
# disposable cluster. Dumps stay on the runner and are deleted at the end; only aggregates are printed.
set -uo pipefail
R=$(git rev-parse --show-toplevel); T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
PGBIN=/usr/lib/postgresql/17/bin
URL=$(cd "$R" && npx tsx -e 'import { resolveConnection } from "./scripts/lib/supabase-db"; const c = resolveConnection(); if (!c) { process.exit(3) } process.stdout.write(c.connectionString)') || { echo "FAIL no DB credential"; exit 1; }
PW=$(node -e 'const u=new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.password))' "$URL"); echo "::add-mask::$PW"; echo "::add-mask::$URL"
w=$(printf 'begin transaction read only;\ncreate temp table _probe(x int);\nrollback;\n' | "$PGBIN/psql" "$URL" -X -qAt 2>&1)
echo "$w" | grep -q "read-only transaction" && echo "PASS production session: write probe refused by the READ ONLY transaction" || { echo "FAIL write probe not refused: stop"; exit 1; }
"$PGBIN/pg_dump" "$URL" --schema-only --no-owner --no-comments -n public -f "$T/public.sql" 2>/dev/null || { echo "FAIL schema dump"; exit 1; }
"$PGBIN/pg_dump" "$URL" --data-only --disable-triggers --no-owner -t 'public.pi_*' -f "$T/data.sql" 2>/dev/null || { echo "FAIL data dump"; exit 1; }
echo "INFO production read: schema $(wc -l < "$T/public.sql") lines, pi_* data $(wc -c < "$T/data.sql") bytes (kept on the runner only)"
INT="$T/int"; git -C "$R" fetch -q --depth=1 origin d8b203d665e62602cec5cb72620f03b5630edd12 && git -C "$R" worktree add -q --detach "$INT" d8b203d665e62602cec5cb72620f03b5630edd12
PG_BIN=$PGBIN SCHEMA_SQL="$T/public.sql" DATA_SQL="$T/data.sql" INT="$INT" bash "$R/scripts/qa/conciliacion/run.sh" "$T/w" 55971
