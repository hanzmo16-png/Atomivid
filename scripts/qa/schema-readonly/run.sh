#!/usr/bin/env bash
# READ-ONLY audit of the production schema for PR #200's proposals (20261024120000 / 130000 / 140000).
# 1) catalog queries in a read-only session; 2) pg_dump --schema-only (no data) in a read-only session;
# 3) that schema restored into a DISPOSABLE local PostgreSQL where the proposals, their rollbacks and a re-apply are replayed.
# Nothing is written to production. The dump never leaves the runner (not uploaded).
set -uo pipefail
R=$(git rev-parse --show-toplevel); OUT=${OUT:-$PWD/schema-out}; mkdir -p "$OUT"; T=$(mktemp -d)
URL=$(cd "$R" && npx tsx -e 'import { resolveConnection } from "./scripts/lib/supabase-db"; const c = resolveConnection(); if (!c) { process.exit(3) } process.stdout.write(c.connectionString)') || { echo "FAIL no DB credential"; exit 1; }
PW=$(node -e 'const u=new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.password))' "$URL"); echo "::add-mask::$PW"; echo "::add-mask::$URL"
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60000'
PGBIN=/usr/lib/postgresql/17/bin
"$PGBIN/psql" "$URL" -X -v ON_ERROR_STOP=1 -c "select 1" >/dev/null 2>"$T/err" || { echo "FAIL connect: $(sed "s/$PW/***/g" "$T/err" | head -3)"; exit 1; }
ro=$("$PGBIN/psql" "$URL" -X -qAt -c "show default_transaction_read_only"); [ "$ro" = on ] || { echo "FAIL session is not read-only ($ro): stop"; exit 1; }
w=$("$PGBIN/psql" "$URL" -X -qAt -c "create temp table _probe(x int)" 2>&1); echo "$w" | grep -q "read-only transaction" && echo "PASS write attempt refused by the read-only session" || { echo "FAIL write probe not refused: $w"; exit 1; }
"$PGBIN/psql" "$URL" -X -v ON_ERROR_STOP=0 -f "$R/scripts/qa/schema-readonly/catalog.sql" > "$OUT/catalog.txt" 2>"$OUT/catalog.err"; cat "$OUT/catalog.txt"; sed "s/$PW/***/g" "$OUT/catalog.err" | head -20
"$PGBIN/pg_dump" "$URL" --schema-only --no-owner --no-privileges --no-comments -n public -f "$T/public.sql" 2>"$T/dump.err" || { echo "FAIL pg_dump: $(sed "s/$PW/***/g" "$T/dump.err" | head -5)"; exit 1; }
echo "INFO schema dump: $(wc -l < "$T/public.sql") lines, sha256 $(sha256sum "$T/public.sql" | cut -c1-16) (kept on the runner only)"
unset PGOPTIONS
# --- replay on a disposable cluster ---
L=$T/local; "$PGBIN/initdb" -D "$L" -U postgres --auth=trust >/dev/null; "$PGBIN/pg_ctl" -D "$L" -o "-p 55990 -k $T -c listen_addresses=''" -l "$T/pg.log" -w start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$L" -m fast stop >/dev/null 2>&1 || true' EXIT
LQ="$PGBIN/psql -h $T -p 55990 -U postgres -X -q"
$LQ -d postgres -c "create database replica" >/dev/null
$LQ -d replica -f "$R/scripts/harness/e2e/infra/stubs.sql" >/dev/null 2>"$T/stubs.err"
$LQ -d replica -c "create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create extension if not exists \"uuid-ossp\" with schema extensions" >/dev/null 2>&1
$LQ -d replica -v ON_ERROR_STOP=0 -f "$T/public.sql" > "$T/restore.log" 2>&1
echo "INFO restore of the production schema: $(grep -c 'ERROR' "$T/restore.log") errors (first 8 below)"; grep 'ERROR' "$T/restore.log" | sort | uniq -c | sort -rn | head -8
step(){ if $LQ -d replica -v ON_ERROR_STOP=1 -f "$2" > "$T/step.log" 2>&1; then echo "PASS $1"; else echo "FAIL $1: $(grep -m3 ERROR "$T/step.log")"; fi; }
P="$R/supabase/proposals"
applied000=$(grep -c "marker 20261024000000 submit refuses podcast without authorization | t" "$OUT/catalog.txt" || true)
[ "$applied000" = 1 ] && echo "INFO 20261024000000 is already applied in production (marker present)" || { echo "INFO 20261024000000 NOT detected in production → replay applies it first"; step "apply 20261024000000 (#198)" "$P/20261024000000_spend_authorizations.sql"; }
step "apply 20261024120000 (#201) on the production schema" "$P/20261024120000_resume_authorization_ref_match.sql"
step "apply 20261024130000 (baseline fix) on the production schema" "$P/20261024130000_spend_authorization_baseline_fix.sql"
step "apply 20261024140000 (studio) on the production schema" "$P/20261024140000_podcast_v3_studio.sql"
step "re-apply 20261024140000 (idempotent)" "$P/20261024140000_podcast_v3_studio.sql"
dep=$($LQ -d replica -qAt -c "select count(*) from pg_depend where refobjid = to_regprocedure('public.pi_supply_state_pre_studio(text)') and classid in ('pg_rewrite'::regclass)")
[ "$dep" = 0 ] && echo "PASS no view still bound to the renamed pi_supply_state_pre_studio" || echo "FINDING $dep view(s) bound by OID to the renamed function (would bypass studio counts)"
step "rollback 20261024140000" "$P/20261024140000_podcast_v3_studio.rollback.sql"
step "rollback 20261024130000" "$P/20261024130000_spend_authorization_baseline_fix.rollback.sql"
step "rollback 20261024120000" "$P/20261024120000_resume_authorization_ref_match.rollback.sql"
st=$($LQ -d replica -qAt -c "select to_regprocedure('public.pi_supply_state_pre_studio(text)') is null and to_regclass('public.podcast_studio_operations') is null and to_regprocedure('public.pi_supply_state(text)') is not null")
[ "$st" = t ] && echo "PASS after rollbacks: studio objects gone, pi_supply_state restored under its own name" || echo "FAIL rollback state ($st)"
step "re-apply 120000 → 130000 → 140000 after rollback" <(cat "$P/20261024120000_resume_authorization_ref_match.sql" "$P/20261024130000_spend_authorization_baseline_fix.sql" "$P/20261024140000_podcast_v3_studio.sql")
rm -rf "$T/public.sql"
