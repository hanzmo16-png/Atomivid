#!/usr/bin/env bash
# O1 rehearsal on a DISPOSABLE PostgreSQL 17 (USD 0). PRODUCTION IS ONLY READ: one read-only session check, then
# pg_dump (schema of public, both registries, pi_* data) with default_transaction_read_only=on. The dumps stay on the
# runner and are deleted at the end; only counts, md5 digests and PASS/FAIL lines are printed. EVERY write below goes to
# the local replica (unix socket in a temp dir, port 55991) through LW(); the gate (cierre.sh) is pointed at the replica
# with SUPABASE_DB_URL and every production credential removed from its environment.
set -uo pipefail
R=$(git rev-parse --show-toplevel); T=$(mktemp -d); PGBIN=/usr/lib/postgresql/17/bin
fails=0; pass(){ echo "PASS $*"; }; fail(){ echo "FAIL $*"; fails=$((fails+1)); }
SQL_A="$R/docs/ops/cierre/A_register_migrations_applied.sql"; SQL_RB="$R/docs/ops/cierre/A_register_migrations_applied.rollback.sql"
SHA_A=577cd97bb715bf145b6b283564ea7bf1889b45dc7c3c5bbf699fd603164e238e; SHA_RB=d171b00ce4992abc90cf2da250e5cbea57a9d38a46485270fe408052a4b088aa
[ "$(sha256sum < "$SQL_A" | cut -d' ' -f1)" = "$SHA_A" ] && [ "$(sha256sum < "$SQL_RB" | cut -d' ' -f1)" = "$SHA_RB" ] && pass "SHA-256 of A ($SHA_A) and rollback ($SHA_RB)" || { fail "SHA-256 mismatch"; exit 1; }
grep -oE "'2026[0-9]{10}_[a-z0-9_]+\.sql'" "$SQL_A" | tr -d "'" | sort -u > "$T/names.txt"; IN="'$(paste -sd, "$T/names.txt" | sed "s/,/','/g")'"

echo "== 1. Production, read-only: dump schema, registries and pi_* data to the runner"
PROD=$(cd "$R" && npx tsx -e 'import { resolveConnection } from "./scripts/lib/supabase-db"; const c = resolveConnection(); if (!c) { process.exit(3) } process.stdout.write(c.connectionString)') || { echo "FAIL no DB credential"; exit 1; }
PW=$(node -e 'const u=new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.password))' "$PROD"); echo "::add-mask::$PW"; echo "::add-mask::$PROD"
ro=$(printf 'begin transaction read only;\nshow transaction_read_only;\nrollback;\n' | "$PGBIN/psql" "$PROD" -X -qAt 2>&1 | grep -E '^(on|off)$'); [ "$ro" = on ] || { echo "FAIL production session not read-only"; exit 1; }
export PGOPTIONS="-c default_transaction_read_only=on"
"$PGBIN/pg_dump" "$PROD" --schema-only --no-owner --no-comments -n public -f "$T/public.sql" 2>/dev/null || { echo "FAIL pg_dump schema"; exit 1; }
"$PGBIN/pg_dump" "$PROD" --data-only --disable-triggers --no-owner -t 'public.pi_*' -t public._migrations_applied -f "$T/data.sql" 2>/dev/null || { echo "FAIL pg_dump data"; exit 1; }
"$PGBIN/pg_dump" "$PROD" --no-owner --no-privileges -n supabase_migrations -f "$T/sm.sql" 2>/dev/null || { echo "FAIL pg_dump registry"; exit 1; }
prod_ma=$(printf 'select count(*) from public._migrations_applied;\n' | "$PGBIN/psql" "$PROD" -X -qAt); prod_pi=$(printf 'select count(*) from public.pi_paid_operations;\n' | "$PGBIN/psql" "$PROD" -X -qAt)
unset PGOPTIONS PROD PW
pass "production read only (default_transaction_read_only=on): _migrations_applied=$prod_ma pi_paid_operations=$prod_pi"

echo "== 2. Disposable replica (pre-O1 state of production)"
L=$T/local; "$PGBIN/initdb" -D "$L" -U postgres --auth=trust >/dev/null; "$PGBIN/pg_ctl" -D "$L" -o "-p 55991 -k $T -c listen_addresses=''" -l "$T/pg.log" -w start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$L" -m fast stop >/dev/null 2>&1 || true; rm -rf "$T/public.sql" "$T/data.sql" "$T/sm.sql"' EXIT
LW(){ "$PGBIN/psql" -h "$T" -p 55991 -U postgres -X -q "$@"; }   # the ONLY write path: local socket
LW -d postgres -c "create database replica" >/dev/null
LW -d replica -f "$R/scripts/harness/e2e/infra/stubs.sql" >/dev/null 2>&1
LW -d replica -c "create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create extension if not exists \"uuid-ossp\" with schema extensions" >/dev/null 2>&1
LW -d replica -f "$T/public.sql" >/dev/null 2>&1; LW -d replica -f "$T/sm.sql" >/dev/null 2>&1; LW -d replica -f "$T/data.sql" >/dev/null 2>&1
q(){ LW -d "${2:-replica}" -At -c "$1"; }
[ "$(q 'select inet_server_port()')" = "" ] && [ "$(q 'show port')" = 55991 ] && pass "write target is the local socket replica (port 55991, no TCP address)" || { fail "write target is not the local replica"; exit 1; }
[ "$(q 'select count(*) from public._migrations_applied')" = "$prod_ma" ] && [ "$(q 'select count(*) from public.pi_paid_operations')" = "$prod_pi" ] && [ "$prod_ma" = 45 ] && [ "$prod_pi" = 548 ] \
  && pass "replica == production pre-O1 state: 45 registered, 548 pi_paid_operations" || fail "replica counts differ: ma=$(q 'select count(*) from public._migrations_applied') pi=$(q 'select count(*) from public.pi_paid_operations')"
LOCAL="postgresql://postgres:replicaonlypw@localhost:55991/replica?host=$T"
md5ma(){ q "select md5(string_agg(t::text, '|' order by t::text)) from public._migrations_applied t" "${1:-replica}"; }
md5pi(){ q "select md5(string_agg(t::text, '|' order by t::text)) from public.pi_paid_operations t" "${1:-replica}"; }
md5mk(){ LW -d "${1:-replica}" -At -v ON_ERROR_STOP=1 -f "$R/scripts/qa/schema-readonly/catalog.sql" 2>/dev/null | grep -E '^marker ' | md5sum | cut -d' ' -f1; }
MA0=$(md5ma); PI0=$(md5pi); MK0=$(md5mk); echo "INFO pre md5: _migrations_applied=$MA0 pi_paid_operations=$PI0 markers=$MK0"
LW -d postgres -c "create database pristine template replica" >/dev/null   # untouched pre-O1 copy for the unexpected-state cases

gate(){ # gate(stage, out) against a replica database only; production credentials removed from the environment
  env -u SUPABASE_DB_PASSWORD -u SUPABASE_URL -u SUPABASE_PROJECT_REF -u SUPABASE_DB_HOST -u SUPABASE_DB_PORT -u NEXT_PUBLIC_SUPABASE_URL \
    SUPABASE_DB_URL="postgresql://postgres:replicaonlypw@localhost:55991/${3:-replica}?host=$T" GATE_ONLY=1 GATE_NEXT="$1" OUT="$T/$2" bash "$R/scripts/qa/schema-readonly/cierre.sh" > "$T/$2.log" 2>&1; }
summ(){ echo "$(grep -c "^PASS GATE\[$1\]" "$T/$2.log") PASS / $(grep -c '^FAIL' "$T/$2.log") FAIL"; }

echo "== 3. Gate O1 on the replica (pre-O1)"
gate O1 g1; g=$?; grep -E '^(PASS|FAIL) GATE|^RESULT' "$T/g1.log"
[ $g = 0 ] && [ "$(grep -c '^PASS GATE\[O1\]' "$T/g1.log")" = 17 ] && ! grep -q '^FAIL' "$T/g1.log" && pass "gate O1 on the replica: $(summ O1 g1)" || fail "gate O1 on the replica: $(summ O1 g1)"
gate O2 g2pre; [ $? != 0 ] && grep -q 'FAIL GATE\[O2\] O1 done' "$T/g2pre.log" && pass "gate O2 refuses the pre-O1 state (fails closed)" || fail "gate O2 did not refuse the pre-O1 state"

echo "== 4. Execute the audited A on the replica"
out=$(LW -d replica -v ON_ERROR_STOP=1 -f "$SQL_A" 2>&1); echo "$out" | grep -E 'INSERT|COMMIT|ERROR'
echo "$out" | grep -q '^INSERT 0 18$' && echo "$out" | grep -q '^COMMIT$' && pass "A: one transaction, INSERT 0 18, COMMIT" || fail "A did not commit 18"
[ "$(q 'select count(*) from public._migrations_applied')" = 63 ] && pass "_migrations_applied = 63" || fail "_migrations_applied = $(q 'select count(*) from public._migrations_applied')"
[ "$(q "select count(*) from public._migrations_applied where name in ($IN)")" = 18 ] && pass "18/18 names registered" || fail "names registered: $(q "select count(*) from public._migrations_applied where name in ($IN)")"
[ "$(q 'select count(*) - count(distinct name) from public._migrations_applied')" = 0 ] && pass "no duplicate names in _migrations_applied" || fail "duplicate names"
[ "$(md5pi)" = "$PI0" ] && [ "$(q 'select count(*) from public.pi_paid_operations')" = 548 ] && pass "pi_paid_operations unchanged (548 rows, same md5)" || fail "pi_paid_operations changed"
[ "$(md5mk)" = "$MK0" ] && pass "function/table markers unchanged by A" || fail "markers changed by A"
MA1=$(md5ma)

echo "== 5. FULL gate O2 on the simulated post-O1 state (fixed reconcile.py)"
gate O2 g2; g=$?; grep -E '^(PASS|FAIL) GATE|^RESULT' "$T/g2.log"
[ $g = 0 ] && ! grep -q '^FAIL' "$T/g2.log" && grep -q '^RESULT cierre: 0 FAIL' "$T/g2.log" && pass "gate O2 on the post-O1 state: $(summ O2 g2)" || fail "gate O2 on the post-O1 state: $(summ O2 g2)"
cp "$R/scripts/qa/schema-readonly/reconcile.py" "$T/reconcile.fixed.py"
git -C "$R" show f0b9711:scripts/qa/schema-readonly/reconcile.py > "$R/scripts/qa/schema-readonly/reconcile.py"
gate O2 g2old; g=$?; cp "$T/reconcile.fixed.py" "$R/scripts/qa/schema-readonly/reconcile.py"
[ $g != 0 ] && grep -q 'FAIL GATE\[O2\] O1 done: nothing left to register (regenerated A has 1 names)' "$T/g2old.log" \
  && pass "control: the previous reconcile.py (f0b9711) reproduces run 40395208058's false FAIL on this same state" || fail "control did not reproduce the previous false FAIL: $(grep '^FAIL' "$T/g2old.log")"
git -C "$R" diff --quiet -- scripts/qa/schema-readonly/reconcile.py && pass "fixed reconcile.py restored after the control" || fail "reconcile.py not restored"

echo "== 6. Idempotency and unexpected states"
out=$(LW -d replica -v ON_ERROR_STOP=1 -f "$SQL_A" 2>&1)
echo "$out" | grep -q 'RECONCILE A: precondition failed' && [ "$(md5ma)" = "$MA1" ] && pass "second run of A refused by its precondition; registry unchanged" || fail "second run of A not refused or registry changed"
gate O1 g1post; [ $? != 0 ] && grep -q '^FAIL GATE\[O1\]' "$T/g1post.log" && pass "gate O1 refuses the post-O1 state (no second execution can pass it)" || fail "gate O1 accepted the post-O1 state"
LW -d postgres -c "create database u1 template pristine" >/dev/null
LW -d u1 -c "insert into public._migrations_applied(name) values ('20261011040000_pilot_run_budget.sql')" >/dev/null
out=$(LW -d u1 -v ON_ERROR_STOP=1 -f "$SQL_A" 2>&1)
echo "$out" | grep -q 'precondition failed' && [ "$(q "select count(*) from public._migrations_applied where name in ($IN)" u1)" = 1 ] && [ "$(q 'select count(*) from public._migrations_applied' u1)" = 46 ] \
  && pass "unexpected state: one of the 18 already registered → A refuses, nothing inserted (46 = 45 + the pre-existing one)" || fail "A did not refuse a pre-registered name cleanly"
gate O1 gu1 u1; [ $? != 0 ] && pass "unexpected state: gate O1 refuses it before any write" || fail "gate O1 accepted a pre-registered name"
LW -d postgres -c "create database u2 template pristine" >/dev/null; LW -d u2 -v ON_ERROR_STOP=1 -f "$SQL_A" >/dev/null 2>&1
LW -d u2 -c "delete from public._migrations_applied where name = '20261024000000_spend_authorizations.sql'" >/dev/null
gate O2 gu2 u2; [ $? != 0 ] && grep -q '^FAIL GATE\[O2\]' "$T/gu2.log" && pass "unexpected state: 17 of 18 registered → gate O2 fails closed" || fail "gate O2 accepted 17/18"
x=$(q "select count(*) from public._migrations_applied where name in ($IN)" u2); a=$(q 'select count(*) from public._migrations_applied' u2)
[ "$x" = 18 ] && [ "$a" = 63 ] && fail "rollback precondition accepted 17/18" || pass "unexpected state: rollback precondition (18 present, 63 total) refuses 17/18 → the workflow would stop, not delete"

echo "== 7. Audited rollback on the post-O1 replica"
x=$(q "select count(*) from public._migrations_applied where name in ($IN)"); a=$(q 'select count(*) from public._migrations_applied')
[ "$x" = 18 ] && [ "$a" = 63 ] && pass "rollback precondition holds (18 present, 63 total)" || fail "rollback precondition"
out=$(LW -d replica -v ON_ERROR_STOP=1 -f "$SQL_RB" 2>&1); echo "$out" | grep -E 'DELETE|COMMIT|ERROR'
echo "$out" | grep -q '^DELETE 18$' && pass "rollback: DELETE 18, COMMIT" || fail "rollback did not delete 18"
[ "$(md5ma)" = "$MA0" ] && [ "$(q 'select count(*) from public._migrations_applied')" = 45 ] && pass "rollback restores _migrations_applied byte-for-byte (45 rows, same md5 as before A)" || fail "registry not restored exactly"
[ "$(md5pi)" = "$PI0" ] && [ "$(md5mk)" = "$MK0" ] && pass "rollback leaves pi_paid_operations (548) and markers identical to the original" || fail "pi_* or markers differ after rollback"
gate O1 g1rb; g=$?; [ $g = 0 ] && [ "$(grep -c '^PASS GATE\[O1\]' "$T/g1rb.log")" = 17 ] && ! grep -q '^FAIL' "$T/g1rb.log" && pass "gate O1 passes again after the rollback ($(summ O1 g1rb))" || fail "gate O1 after rollback: $(summ O1 g1rb)"

echo "RESULT o1-replica: $fails FAIL"
exit $([ $fails = 0 ] && echo 0 || echo 1)
