#!/usr/bin/env bash
# O3 rehearsal on a DISPOSABLE PostgreSQL 17 (USD 0). PRODUCTION IS ONLY READ: o2.sh `done` (O2 is really completed),
# o3.sh snapshot + `pre`, the tool-connection probe and the O2 run on GitHub (all read-only), then pg_dump with
# default_transaction_read_only=on. Every write goes to the local replica (unix socket, port 55996): `o3.sh apply` runs
# with SUPABASE_DB_URL = the replica and every production credential removed from its environment.
# Harness discipline (harness-lib.sh): any unexpected harness error (missing command, shell error, early exit) ends in
# a non-zero exit and a failed RESULT; expect_reject demands the real exit code, the exact FAIL count and RESULT line.
R=$(git rev-parse --show-toplevel); T=$(mktemp -d); PGBIN=/usr/lib/postgresql/17/bin
O2="$R/scripts/qa/schema-readonly/o2.sh"; O3="$R/scripts/qa/schema-readonly/o3.sh"
H_NAME=o3-replica; . "$R/scripts/qa/schema-readonly/harness-lib.sh"; export OUT=$T
NAME=20261024130000_spend_authorization_baseline_fix.sql

echo "== 1. Production, READ ONLY: O2 done, O3 preconditions, O2 run evidence, probe, dumps"
PROD=$(cd "$R" && npx tsx -e 'import { resolveConnection } from "./scripts/lib/supabase-db"; const c = resolveConnection(); if (!c) { process.exit(3) } process.stdout.write(c.connectionString)') || { echo "FAIL no DB credential"; exit 1; }
PW=$(node -e 'const u=new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.password))' "$PROD"); echo "::add-mask::$PW"; echo "::add-mask::$PROD"
bash "$O2" snap "$PROD" "$T/prod-o2.snap" > /dev/null && bash "$O2" done "$T/prod-o2.snap" > "$T/prod-o2.done" && pass "production: o2.sh done (audited post-O2 state) passes on a fresh read" || { fail "production O2 not in the audited done state"; grep FAIL "$T/prod-o2.done"; }
bash "$O3" o2run 40427566003 && pass "O2 run 40427566003: one-shot workflow, workflow_dispatch, SHA 0d55b5b, success" || fail "O2 run evidence"
bash "$O3" o2run 40413515577 > "$T/o2run-neg.out"; grep -q '^FAIL O3\[o2run\]' "$T/o2run-neg.out" && pass "negative: another run (O1's) is refused as O2 evidence" || fail "o2run accepted a foreign run"
bash "$O3" snap "$PROD" "$T/prod.snap" > "$T/prod.snaplog" || { cat "$T/prod.snaplog"; echo "FAIL production snapshot"; exit 1; }
bash "$O3" pre "$T/prod.snap" && pass "production meets every O3 precondition right now" || fail "production does not meet the O3 preconditions"
bash "$O3" probe && pass "production: tool connection statement_timeout=2min, read-only probe" || fail "probe"
export PGOPTIONS="-c default_transaction_read_only=on"
"$PGBIN/pg_dump" "$PROD" --schema-only --no-owner --no-comments -n public -f "$T/public.sql" 2>/dev/null || { echo "FAIL pg_dump schema"; exit 1; }
"$PGBIN/pg_dump" "$PROD" --data-only --disable-triggers --no-owner -t 'public.pi_*' -t public._migrations_applied -f "$T/data.sql" 2>/dev/null || { echo "FAIL pg_dump data"; exit 1; }
"$PGBIN/pg_dump" "$PROD" --no-owner --no-privileges -n supabase_migrations -f "$T/sm.sql" 2>/dev/null || { echo "FAIL pg_dump registry"; exit 1; }
unset PGOPTIONS PROD PW

echo "== 2. Disposable replica (current post-O2 production state)"
L=$T/local; "$PGBIN/initdb" -D "$L" -U postgres --auth=trust >/dev/null; "$PGBIN/pg_ctl" -D "$L" -o "-p 55996 -k $T -c listen_addresses=''" -l "$T/pg.log" -w start >/dev/null
H_CLEANUP='"$PGBIN/pg_ctl" -D "$L" -m fast stop >/dev/null 2>&1 || true; rm -rf "$T/public.sql" "$T/data.sql" "$T/sm.sql"'
LW(){ "$PGBIN/psql" -h "$T" -p 55996 -U postgres -X -q "$@"; }   # the ONLY direct write path: local socket
LW -d postgres -c "create database replica" >/dev/null
LW -d replica -f "$R/scripts/harness/e2e/infra/stubs.sql" >/dev/null 2>&1
LW -d replica -c "create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create extension if not exists \"uuid-ossp\" with schema extensions" >/dev/null 2>&1
LW -d replica -f "$T/public.sql" >/dev/null 2>&1; LW -d replica -f "$T/sm.sql" >/dev/null 2>&1; LW -d replica -f "$T/data.sql" >/dev/null 2>&1
U(){ echo "postgresql://postgres@localhost/${1:-replica}?host=$T&port=55996"; }
q(){ LW -d "${2:-replica}" -At -c "$1"; }
[ "$(q 'show port')" = 55996 ] && [ -z "$(q 'select inet_server_port()')" ] && pass "write target is the local socket replica (port 55996, no TCP)" || { fail "write target is not the local replica"; exit 1; }
TOOLENV=(env -u SUPABASE_DB_PASSWORD -u SUPABASE_PROJECT_REF -u SUPABASE_URL -u SUPABASE_DB_HOST -u SUPABASE_DB_PORT SUPABASE_DB_URL="$(U)")
o3(){ "${TOOLENV[@]}" bash "$O3" "$@"; }
snap(){ bash "$O3" snap "$(U "${2:-replica}")" "$T/$1.snaplog.snap" > "$T/$1.snaplog" 2>&1 && mv "$T/$1.snaplog.snap" "$T/$1.snap" || { fail "snapshot $1 failed or incomplete: $(grep FAIL "$T/$1.snaplog" | head -2)"; echo "aborted: no check may run on a broken snapshot"; exit 1; }; }
cls(){ o3 classify "$1" 2>&1 || true; }
gate(){ local g=0 want=$3; "${TOOLENV[@]}" GATE_ONLY=1 GATE_NEXT=$1 OUT="$T/gate-$1-$2" bash "$R/scripts/qa/schema-readonly/cierre.sh" > "$T/gate-$1-$2.log" 2>&1 || g=$?
  local n; n=$(grep -c "^PASS GATE\[$1\]" "$T/gate-$1-$2.log"); [ $g = 0 ] && ! grep -q '^FAIL' "$T/gate-$1-$2.log" && [ "$n" = "$want" ] && pass "gate $1 on the replica ($2): $want PASS, 0 FAIL" || { fail "gate $1 on the replica ($2): rc=$g PASS=$n (want $want)"; grep '^FAIL' "$T/gate-$1-$2.log"; }; }
# production's ACLs on the touched / checked functions (the local stubs grant anon/authenticated by default)
LW -d replica -c "revoke all on function public.pi_open_spend_authorization(uuid,numeric,text) from public, anon, authenticated; grant execute on function public.pi_open_spend_authorization(uuid,numeric,text) to service_role;
  revoke all on function public.pi_documentary_resume_requires_budget() from public, anon, authenticated, service_role;
  revoke all on function public.pi_recovery_resume_authorization(text,text) from public, anon, authenticated; grant execute on function public.pi_recovery_resume_authorization(text,text) to service_role;
  revoke all on public.pi_recovery_resume_authorizations from public, anon, authenticated, service_role" >/dev/null
LW -d replica -c "alter role postgres set statement_timeout = '2min'" >/dev/null
snap r0; expect_ok "replica meets the O3 preconditions" "$T/r0.pre" -- o3 pre "$T/r0.snap"
same=1; for k in ma_count ma_has_o2 ma_has_o3 ma_md5_without_o3 sm_md5 pi_paid_operations open_operations pi_rows m000 m120 m130 m140 fn_src_md5 fn_def_md5 fn_attr fn_acl exec_fn auth_rows auth_md5 usage_md5; do
  [ "$(grep "^$k|" "$T/r0.snap")" = "$(grep "^$k|" "$T/prod.snap")" ] || { same=0; fail "replica differs from production in $k"; }; done
[ $same = 1 ] && pass "replica == production in registries, pi_* rows, markers, function body (prosrc + functiondef), attributes, ACL, EXECUTE, authorizations and their usage"
bash "$O2" snap "$(U)" "$T/r0-o2.snap" >/dev/null && bash "$O2" done "$T/r0-o2.snap" >/dev/null && pass "replica: o2.sh done passes (O2 objects as in production)" || fail "replica o2 done"
gate O3 before 16

# behaviour (the bug 130000 fixes): open an authorization for a podcast episode that has one RESERVED and one COMMITTED
# operation. PR198 puts both in the baseline (the RESERVED one is never counted against the cap once submitted); 130000
# keeps only the settled one. Synthetic episode + two ledger rows cloned from an existing row's shape; always rolled back.
PID=e0000000-0000-4000-8000-0000000003a0
probe(){ LW -d replica -At 2>&1 <<SQL | grep -E '^(BASE|ERROR)' | head -1
begin;
insert into auth.users(id, email) values ('cccccccc-0000-4000-8000-0000000000e3', 'o3@x') on conflict do nothing;
insert into public.podcast_episodes(id, user_id, title, source) values ('$PID', 'cccccccc-0000-4000-8000-0000000000e3', 'o3 probe', 'upload');
insert into public.pi_paid_operations select (jsonb_populate_record(null::public.pi_paid_operations, to_jsonb(o)
  || jsonb_build_object('project_id', 'podcast-$PID', 'idempotency_key', 'o3-probe-' || v.n, 'status', v.s))).*
  from (select * from public.pi_paid_operations order by idempotency_key limit 1) o, (values (1, 'RESERVED'), (2, 'COMMITTED')) v(n, s);
set local role service_role;
select 'BASE ' || (r->>'opened') || ' ' || (r->>'baselineOperations') from (select public.pi_open_spend_authorization('$PID', 1, 'o3-probe') r) x;
rollback;
SQL
}
# Effective access by role on the touched function, inside a transaction that is always rolled back: PostgreSQL itself
# must refuse anon and authenticated; service_role must execute it (a random id answers 'episode not found'). Plus the
# catalog (proacl, has_function_privilege) and proof that the calls left no persistent effect.
FN="public.pi_open_spend_authorization(uuid,numeric,text)"
fp(){ q "select (select md5(coalesce(string_agg(a::text, '|' order by a::text), '')) from public.pi_spend_authorizations a) || ':' || (select md5(coalesce(string_agg(o::text, '|' order by o::text), '')) from public.pi_paid_operations o)" "${1:-replica}"; }
access(){ local label=$1 db=${2:-replica} r out line ok=1 before after acl ex
  before=$(fp "$db")
  for r in anon authenticated service_role; do
    out=$(LW -d "$db" -At -v ON_ERROR_STOP=1 2>&1 <<SQL
begin;
set local role $r;
select 'R ' || coalesce(public.pi_open_spend_authorization('e0000000-0000-4000-8000-0000000003ff', 1, 'o3-access')->>'reason', 'null');
rollback;
SQL
) || true
    line=$(printf '%s\n' "$out" | grep -E '^R |ERROR' | head -n 1)
    case $r in
      service_role) [ "$line" = "R episode not found" ] || ok=0;;
      *) printf '%s\n' "$line" | grep -q 'permission denied for function pi_open_spend_authorization' || ok=0;;
    esac
    echo "INFO $label · $r: $line"
  done
  [ $ok = 1 ] && pass "$label: anon and authenticated refused by PostgreSQL (permission denied), service_role executes" || fail "$label: effective access by role"
  acl=$(q "select coalesce(proacl::text, '') from pg_proc where oid = '$FN'::regprocedure" "$db")
  [ "$acl" = '{postgres=X/postgres,service_role=X/postgres}' ] && pass "$label: ACL = $acl" || fail "$label: ACL = [$acl]"
  ex=$(q "select string_agg(r || '=' || has_function_privilege(r, '$FN', 'execute'), ',' order by r) from unnest(array['anon','authenticated','service_role']) r" "$db")
  [ "$ex" = 'anon=false,authenticated=false,service_role=true' ] && pass "$label: EXECUTE $ex" || fail "$label: EXECUTE [$ex]"
  after=$(fp "$db"); [ -n "$before" ] && [ "$before" = "$after" ] && pass "$label: no persistent effect (authorizations and ledger fingerprints unchanged)" || fail "$label: the access probe changed data"; }
access "access before O3"
TOT=2; RES=1
b0=$(probe); [ "$b0" = "BASE true 2" ] && pass "before O3: the baseline includes the RESERVED operation (2 of 2) — the defect 130000 fixes" || fail "before O3 probe: [$b0] want BASE true 2"
[ "$(q "select count(*) from public.pi_paid_operations where project_id = 'podcast-$PID'")" = 0 ] && pass "probe rows rolled back" || fail "probe rows persisted"

echo "== 3. O3 on the replica exactly as the workflow runs it"
o3 apply > "$T/apply1.log" 2>&1 && pass "o3.sh apply: exit 0, '1 aplicada [$NAME], 0 reconciliadas'" || { fail "o3.sh apply"; tail -5 "$T/apply1.log"; }
snap r1; expect_ok "o3.sh post: every post-O3 check passes" "$T/r1.post" -- o3 post "$T/r0.snap" "$T/r1.snap"
o3 done "$T/r1.snap" > /dev/null && pass "positive: o3.sh done passes on the post-O3 state" || fail "done positive"
grep -q 'O3 STATE: COMPLETADO' <(cls "$T/r1.snap") && pass "classify post-O3 = COMPLETADO" || fail "classify post"
grep -q 'O3 STATE: PRE' <(cls "$T/r0.snap") && pass "classify pre-O3 = PRE" || fail "classify pre"
gate O4 after 17
access "access after O3"
b1=$(probe); [ "$b1" = "BASE true 1" ] && pass "after O3: the baseline keeps only the settled operation (1 of 2)" || fail "after O3 probe: [$b1] want BASE true 1"
expect_reject "N1 second run on the post-O3 state stops at 'pre'" 3 1 "$T/n1.out" "_migrations_applied rows | 120000 | 130000" "markers 000000" "pi_open_spend_authorization body (prosrc md5) == PR198" -- o3 pre "$T/r1.snap"
o3 apply > "$T/apply2.log" 2>&1; grep -q 'ya está registrada como aplicada' "$T/apply2.log" && grep -q 'Resumen: 0 aplicada' "$T/apply2.log" && pass "re-running the tool: skipped, 0 applied" || fail "tool re-run"
snap r1b; cmp -s <(grep -v '^read_only' "$T/r1.snap") <(grep -v '^read_only' "$T/r1b.snap") && pass "re-run changed nothing (complete snapshots identical)" || fail "re-run changed state"

echo "== 4. Contingency"
LW -d postgres -c "create database onlyrb template replica" >/dev/null
"$PGBIN/psql" "$(U onlyrb)" -X -q -v ON_ERROR_STOP=1 -f "$R/supabase/proposals/${NAME%.sql}.rollback.sql" >/dev/null 2>&1; snap rb onlyrb
expect_reject "N4 audited rollback ALONE leaves the registry row" 2 1 "$T/rb.same" "ma_count unchanged" "ma_has_o3 unchanged" -- bash "$O3" same "$T/r0.snap" "$T/rb.snap"
"$PGBIN/psql" "$(U)" -X -q -v ON_ERROR_STOP=1 -f "$R/docs/ops/o3/O3_contingencia_registro.sql" > /dev/null 2> "$T/ct0.err"; rc=$?; snap n2
[ $rc != 0 ] && grep -q 'O3 CONTINGENCIA: precondition failed' "$T/ct0.err" && cmp -s <(grep -v '^read_only' "$T/r1.snap") <(grep -v '^read_only' "$T/n2.snap") && pass "N2 step 2 before step 1: refused, state byte-identical" || fail "N2 (rc=$rc)"
o3 contingency "$(U)" > "$T/ct1.log" 2>&1 && pass "o3.sh contingency: both steps exit 0" || { fail "contingency"; tail -5 "$T/ct1.log"; }
snap r2; expect_ok "after the contingency the replica is EXACTLY the pre-O3 state" "$T/r2.same" -- o3 same "$T/r0.snap" "$T/r2.snap"
o3 verdict "$T/r0.snap" "$T/r2.snap" > "$T/v2.out"; [ $? = 0 ] && pass "verdict = REVERTIDO" || fail "verdict clean"
gate O3 restored 16
access "access after the contingency (permissions restored)"
b2=$(probe); [ "$b2" = "BASE true 2" ] && pass "after the contingency: PR198 behaviour is back (2 of 2)" || fail "restored probe [$b2]"
o3 contingency "$(U)" > /dev/null 2>&1 && snap r2b && o3 same "$T/r0.snap" "$T/r2b.snap" > /dev/null && pass "contingency is re-runnable" || fail "contingency second run"

echo "== 5. Fault injection and regressions"
# applied but unregistered (the tool's registry insert is outside the migration's own transaction)
"$PGBIN/psql" "$(U)" -X -q -v ON_ERROR_STOP=1 -f "$R/supabase/migrations/$NAME" >/dev/null 2>&1; snap n3
expect_reject "N3 SQL applied but unregistered: post" 1 1 "$T/n3.out" "= 64|1|0 (expected 65|1|1)" -- o3 post "$T/r0.snap" "$T/n3.snap"
grep -q 'PARCIAL_SIN_REGISTRO' <(cls "$T/n3.snap") && pass "classify = PARCIAL_SIN_REGISTRO" || fail "classify n3"
expect_ok "N3 recovery: contingency (rollback + registry step) from SQL-applied-without-registry exits 0" "$T/n3.ct" -- o3 contingency "$(U)"
snap n3b; expect_ok "N3 recovery restores exactly the pre-O3 state" "$T/n3b.same" -- o3 same "$T/r0.snap" "$T/n3b.snap"
access "access after recovering from SQL applied without registry"
# registry only
LW -d postgres -c "create database regonly template replica" >/dev/null; LW -d regonly -c "insert into public._migrations_applied(name) values ('$NAME')" >/dev/null; snap n7 regonly
grep -q 'PARCIAL_SOLO_REGISTRO' <(cls "$T/n7.snap") && pass "N7 registry row without SQL = PARCIAL_SOLO_REGISTRO" || fail "N7"
# tampered body with the marker kept
LW -d postgres -c "create database tamper template replica" >/dev/null
sed "s/'uncertain operations must be reconciled first'/'uncertain operations must be reconciled'/" "$R/supabase/migrations/$NAME" > "$T/tampered.sql"
"$PGBIN/psql" "$(U tamper)" -X -q -v ON_ERROR_STOP=1 -f "$T/tampered.sql" >/dev/null 2>&1 && LW -d tamper -c "insert into public._migrations_applied(name) values ('$NAME')" >/dev/null; snap n6 tamper
expect_reject "N6 tampered body (marker 130000 still t): done" 1 1 "$T/n6.out" "body (prosrc md5) == migration 56a24ada" -- o3 done "$T/n6.snap"
grep -q 'INDETERMINADO' <(cls "$T/n6.snap") && pass "N6 classify = INDETERMINADO" || fail "N6 classify"
# truncated / duplicated snapshots
head -n 12 "$T/r0.snap" > "$T/trunc.snap"
expect_reject "N5 truncated snapshot refused by pre" 1 1 "$T/n5.out" "snapshot $T/trunc.snap incomplete" -- o3 pre "$T/trunc.snap"
{ cat "$T/r0.snap"; echo "usage_md5|00"; } > "$T/dup.snap"
expect_reject "N5 duplicated key refused by same" 1 1 "$T/n5b.out" "duplicated:usage_md5" -- o3 same "$T/r0.snap" "$T/dup.snap"
# concurrent change of protected data between pre and post -> post fails on it; contingency -> BLOQUEADO, data kept
snap n8pre
LW -d replica -c "insert into auth.users(id, email) values ('cccccccc-0000-4000-8000-0000000000e4', 'o3c@x') on conflict do nothing; insert into public.podcast_episodes(id, user_id, title, source) values ('e0000000-0000-4000-8000-0000000003b0', 'cccccccc-0000-4000-8000-0000000000e4', 'concurrente', 'upload')" >/dev/null
o3 apply > "$T/n8.apply" 2>&1 || fail "N8 setup: apply"; snap n8post
expect_reject "N8 concurrent podcast change between pre and post: post" 1 1 "$T/n8.out" "podcast_md5 unchanged" -- o3 post "$T/n8pre.snap" "$T/n8post.snap"
o3 contingency "$(U)" > "$T/n8.ct" 2>&1 || fail "N8 contingency"; snap n8after; o3 verdict "$T/n8pre.snap" "$T/n8after.snap" > "$T/v8.out"; rc=$?
[ $rc = 3 ] && grep -q 'BLOQUEADO' "$T/v8.out" && [ "$(grep -c '^FAIL' "$T/v8.out")" = 1 ] && pass "N8 verdict = BLOQUEADO (exit 3), only the concurrent row differs" || { fail "N8 verdict rc=$rc"; cat "$T/v8.out"; }
[ "$(q "select title from public.podcast_episodes where id = 'e0000000-0000-4000-8000-0000000003b0'")" = concurrente ] && pass "N8 the concurrent row is untouched" || fail "N8 row modified"
LW -d replica -c "delete from public.podcast_episodes where id = 'e0000000-0000-4000-8000-0000000003b0'" >/dev/null; snap n8c; o3 same "$T/r0.snap" "$T/n8c.snap" >/dev/null && pass "N8 cleanup: exact pre-O3 state" || fail "N8 cleanup"
# contingency step 1 fails (another session holds the function row lock past statement_timeout): step 2 must not run
o3 apply > /dev/null 2>&1 || fail "N9 setup"
LW -d replica -c "alter role postgres set statement_timeout = '6s'" >/dev/null
( PGOPTIONS="-c statement_timeout=0" LW -d replica -c "begin; alter function public.pi_open_spend_authorization(uuid,numeric,text) set search_path = ''; select pg_sleep(20); rollback;" >/dev/null 2>&1 ) & H=$!; sleep 1
o3 contingency "$(U)" > "$T/ct9.log" 2>&1; rc=$?; kill $H 2>/dev/null; wait $H 2>/dev/null; LW -d replica -c "alter role postgres set statement_timeout = '2min'" >/dev/null; snap n9
[ $rc != 0 ] && grep -q 'step 1 failed: STOP, step 2 NOT run' "$T/ct9.log" && ! grep -q 'step 2:' "$T/ct9.log" && [ "$(grep '^ma_has_o3|' "$T/n9.snap" | cut -d'|' -f2)" = 1 ] && pass "N9 step 1 failed: contingency stopped, step 2 not run" || { fail "N9 rc=$rc"; tail -4 "$T/ct9.log"; }
grep -q 'COMPLETADO' <(cls "$T/n9.snap") && pass "N9 classify = COMPLETADO (rollback rolled back as a whole)" || fail "N9 classify"
expect_ok "N9 recovery: contingency re-run after the failed step 1 exits 0" "$T/n9.ct2" -- o3 contingency "$(U)"
snap n9b; expect_ok "N9 recovery restores exactly the pre-O3 state" "$T/n9b.same" -- o3 same "$T/r0.snap" "$T/n9b.snap"
access "access after recovering from a failed contingency step 1"
# N11: the access check itself must catch a wrong grant (effective access + ACL), on throw-away clones
LW -d postgres -c "create database accneg template replica" >/dev/null && LW -d accneg -c "grant execute on function $FN to anon" >/dev/null
out=$( (access "N11a" accneg) 2>&1 ); printf '%s\n' "$out" | grep -q '^FAIL N11a: effective access by role' && printf '%s\n' "$out" | grep -q '^FAIL N11a: ACL' && pass "N11a anon granted EXECUTE: access check reports FAIL (effective access and ACL)" || { fail "N11a not detected"; printf '%s\n' "$out"; }
LW -d postgres -c "create database accneg2 template replica" >/dev/null && LW -d accneg2 -c "revoke execute on function $FN from service_role" >/dev/null
out=$( (access "N11b" accneg2) 2>&1 ); printf '%s\n' "$out" | grep -q '^FAIL N11b: effective access by role' && pass "N11b service_role revoked: access check reports FAIL" || { fail "N11b not detected"; printf '%s\n' "$out"; }
# binding
o3 bind 0000000000000000000000000000000000000000 > "$T/n10.out"; grep -q '^FAIL O3\[bind\] checked-out commit' "$T/n10.out" && pass "N10 bind refuses a different SHA" || fail "N10"
o3 bind "$(git -C "$R" rev-parse HEAD)" > /dev/null && pass "positive: bind accepts the checked-out SHA" || fail "bind positive"

echo "== 6. Repeatability"
o3 apply > /dev/null 2>&1 && snap r6 && o3 post "$T/r0.snap" "$T/r6.snap" > /dev/null && pass "forward path repeatable after the contingency" || fail "forward not repeatable"
d=$(diff <(grep -v '^read_only|' "$T/r1.snap") <(grep -v '^read_only|' "$T/r6.snap") | grep -c '^<'); [ "$d" = 0 ] && pass "second forward identical to the first (every fact)" || fail "second forward differs in $d facts"
h_finish
