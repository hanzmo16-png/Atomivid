#!/usr/bin/env bash
# O3 rehearsal on a DISPOSABLE PostgreSQL 17 (USD 0). PRODUCTION IS ONLY READ: o2.sh `done` (O2 is really completed),
# o3.sh snapshot + `pre`, the tool-connection probe and the O2 run on GitHub (all read-only), then pg_dump with
# default_transaction_read_only=on. Every write goes to the local replica (unix socket, port 55996): `o3.sh apply` runs
# with SUPABASE_DB_URL = the replica and every production credential removed from its environment.
set -uo pipefail
R=$(git rev-parse --show-toplevel); T=$(mktemp -d); PGBIN=/usr/lib/postgresql/17/bin
O2="$R/scripts/qa/schema-readonly/o2.sh"; O3="$R/scripts/qa/schema-readonly/o3.sh"
export OUT=$T; fails=0; pass(){ echo "PASS $*"; }; fail(){ echo "FAIL $*"; fails=$((fails+1)); }
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
trap '"$PGBIN/pg_ctl" -D "$L" -m fast stop >/dev/null 2>&1 || true; rm -rf "$T/public.sql" "$T/data.sql" "$T/sm.sql"' EXIT
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
snap(){ bash "$O3" snap "$(U "${2:-replica}")" "$T/$1.snap" > "$T/$1.snaplog" 2>&1 || { fail "snapshot $1 failed or incomplete: $(grep FAIL "$T/$1.snaplog" | head -2)"; echo "RESULT o3-replica: $fails FAIL (aborted: no check may run on a broken snapshot)"; exit 1; }; }
cls(){ o3 classify "$1" 2>&1 || true; }
rejects(){ local label=$1 n=$2 out=$3; shift 3; local rc=0 f; f=$(grep '^FAIL' "$out"); grep -q '^RESULT .*: 0 FAIL' "$out" && rc=1
  local missing=""; for r in "$@"; do printf '%s\n' "$f" | grep -qF -- "$r" || missing="$missing [$r]"; done
  local c; c=$(printf '%s' "$f" | grep -c '^FAIL')
  [ $rc = 0 ] && [ -z "$missing" ] && [ "$c" = "$n" ] && pass "$label: rejected for exactly the expected $n reason(s)" || { fail "$label: rc_ok=$((1-rc)) missing:${missing:- none} fail_lines=$c (want $n)"; printf '%s\n' "$f" | head -8; }; }
gate(){ local g=0 want=$3; "${TOOLENV[@]}" GATE_ONLY=1 GATE_NEXT=$1 OUT="$T/gate-$1-$2" bash "$R/scripts/qa/schema-readonly/cierre.sh" > "$T/gate-$1-$2.log" 2>&1 || g=$?
  local n; n=$(grep -c "^PASS GATE\[$1\]" "$T/gate-$1-$2.log"); [ $g = 0 ] && ! grep -q '^FAIL' "$T/gate-$1-$2.log" && [ "$n" = "$want" ] && pass "gate $1 on the replica ($2): $want PASS, 0 FAIL" || { fail "gate $1 on the replica ($2): rc=$g PASS=$n (want $want)"; grep '^FAIL' "$T/gate-$1-$2.log"; }; }
# production's ACLs on the touched / checked functions (the local stubs grant anon/authenticated by default)
LW -d replica -c "revoke all on function public.pi_open_spend_authorization(uuid,numeric,text) from public, anon, authenticated; grant execute on function public.pi_open_spend_authorization(uuid,numeric,text) to service_role;
  revoke all on function public.pi_documentary_resume_requires_budget() from public, anon, authenticated, service_role;
  revoke all on function public.pi_recovery_resume_authorization(text,text) from public, anon, authenticated; grant execute on function public.pi_recovery_resume_authorization(text,text) to service_role;
  revoke all on public.pi_recovery_resume_authorizations from public, anon, authenticated, service_role" >/dev/null
LW -d replica -c "alter role postgres set statement_timeout = '2min'" >/dev/null
snap r0; o3 pre "$T/r0.snap" > "$T/r0.pre" && pass "replica meets the O3 preconditions" || { fail "replica pre"; grep FAIL "$T/r0.pre"; }
same=1; for k in ma_count ma_has_o2 ma_has_o3 ma_md5_without_o3 sm_md5 pi_paid_operations open_operations pi_rows m000 m120 m130 m140 fn_src_md5 fn_def_md5 fn_attr fn_acl exec_fn auth_rows auth_md5 usage_md5; do
  [ "$(grep "^$k|" "$T/r0.snap")" = "$(grep "^$k|" "$T/prod.snap")" ] || { same=0; fail "replica differs from production in $k"; }; done
[ $same = 1 ] && pass "replica == production in registries, pi_* rows, markers, function body (prosrc + functiondef), attributes, ACL, EXECUTE, authorizations and their usage"
bash "$O2" snap "$(U)" "$T/r0-o2.snap" >/dev/null && bash "$O2" done "$T/r0-o2.snap" >/dev/null && pass "replica: o2.sh done passes (O2 objects as in production)" || fail "replica o2 done"
gate O3 before 16

# behaviour (the bug 130000 fixes): open an authorization for a podcast project that has RESERVED operations. PR198 puts
# them in the baseline (never counted against the cap); 130000 leaves them out. Synthetic episode row, always rolled back.
PID=$(q "select substr(project_id, 9) from public.pi_paid_operations where project_id ~ '^podcast-[0-9a-f-]{36}\$' group by project_id
  having bool_or(status = 'RESERVED') and not bool_or(status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED'))
  and project_id not in (select project_id from public.pi_spend_authorizations) order by 1 limit 1")
probe(){ LW -d replica -At 2>&1 <<SQL | grep -E '^(BASE|ERROR)' | head -1
begin;
insert into auth.users(id, email) values ('cccccccc-0000-4000-8000-0000000000e3', 'o3@x') on conflict do nothing;
insert into public.podcast_episodes(id, user_id, title, source) values ('$PID', 'cccccccc-0000-4000-8000-0000000000e3', 'o3 probe', 'upload');
set local role service_role;
select 'BASE ' || (r->>'opened') || ' ' || (r->>'baselineOperations') from (select public.pi_open_spend_authorization('$PID', 1, 'o3-probe') r) x;
rollback;
SQL
}
if [ -n "$PID" ]; then
  TOT=$(q "select count(*) from public.pi_paid_operations where project_id = 'podcast-$PID'"); RES=$(q "select count(*) from public.pi_paid_operations where project_id = 'podcast-$PID' and status = 'RESERVED'")
  b0=$(probe); [ "$b0" = "BASE true $TOT" ] && pass "before O3: baseline includes the $RES RESERVED operation(s) ($b0 of $TOT) — the defect" || fail "before O3 probe: [$b0] want BASE true $TOT"
else echo "INFO no production podcast project with RESERVED operations and no authorization: behaviour probe skipped"; fi

# effective access by role (not only the ACL text): anon / authenticated are refused, service_role can call it
access(){ local r out; for r in anon authenticated; do out=$(LW -d replica -At -c "begin; set local role $r; select public.pi_open_spend_authorization('00000000-0000-4000-8000-000000000000', 1, 'x'); rollback;" 2>&1)
    echo "$out" | grep -q 'permission denied for function pi_open_spend_authorization' || { fail "$1: role $r was not refused ($out)"; return; }; done
  out=$(LW -d replica -At -c "begin; set local role service_role; select public.pi_open_spend_authorization('00000000-0000-4000-8000-000000000000', 1, 'x')->>'reason'; rollback;" 2>&1)
  [ "$out" = "episode not found" ] && pass "$1: anon and authenticated refused (permission denied); service_role executes (episode not found)" || fail "$1: service_role call [$out]"; }
access "access before O3"

echo "== 3. O3 on the replica exactly as the workflow runs it"
o3 apply > "$T/apply1.log" 2>&1 && pass "o3.sh apply: exit 0, '1 aplicada [$NAME], 0 reconciliadas'" || { fail "o3.sh apply"; tail -5 "$T/apply1.log"; }
snap r1; o3 post "$T/r0.snap" "$T/r1.snap" > "$T/r1.post" && pass "o3.sh post: every post-O3 check passes ($(grep -c '^PASS' "$T/r1.post") checks)" || { fail "o3.sh post"; grep FAIL "$T/r1.post"; }
o3 done "$T/r1.snap" > /dev/null && pass "positive: o3.sh done passes on the post-O3 state" || fail "done positive"
grep -q 'O3 STATE: COMPLETADO' <(cls "$T/r1.snap") && pass "classify post-O3 = COMPLETADO" || fail "classify post"
grep -q 'O3 STATE: PRE' <(cls "$T/r0.snap") && pass "classify pre-O3 = PRE" || fail "classify pre"
gate O4 after 17
access "access after O3"
if [ -n "$PID" ]; then b1=$(probe); [ "$b1" = "BASE true $((TOT - RES))" ] && pass "after O3: baseline excludes the RESERVED operation(s) ($b1 of $TOT)" || fail "after O3 probe: [$b1] want BASE true $((TOT - RES))"; fi
o3 pre "$T/r1.snap" > "$T/n1.out"
rejects "N1 second run on the post-O3 state stops at 'pre'" 3 "$T/n1.out" "_migrations_applied rows | 120000 | 130000" "markers 000000" "pi_open_spend_authorization body (prosrc md5) == PR198"
o3 apply > "$T/apply2.log" 2>&1; grep -q 'ya está registrada como aplicada' "$T/apply2.log" && grep -q 'Resumen: 0 aplicada' "$T/apply2.log" && pass "re-running the tool: skipped, 0 applied" || fail "tool re-run"
snap r1b; cmp -s <(grep -v '^read_only' "$T/r1.snap") <(grep -v '^read_only' "$T/r1b.snap") && pass "re-run changed nothing (complete snapshots identical)" || fail "re-run changed state"

echo "== 4. Contingency"
LW -d postgres -c "create database onlyrb template replica" >/dev/null
"$PGBIN/psql" "$(U onlyrb)" -X -q -v ON_ERROR_STOP=1 -f "$R/supabase/proposals/${NAME%.sql}.rollback.sql" >/dev/null 2>&1; snap rb onlyrb
bash "$O3" same "$T/r0.snap" "$T/rb.snap" > "$T/rb.same"
rejects "N4 audited rollback ALONE leaves the registry row" 3 "$T/rb.same" "ma_count unchanged" "ma_has_o3 unchanged" "ma_md5_without_o3"
"$PGBIN/psql" "$(U)" -X -q -v ON_ERROR_STOP=1 -f "$R/docs/ops/o3/O3_contingencia_registro.sql" > /dev/null 2> "$T/ct0.err"; rc=$?; snap n2
[ $rc != 0 ] && grep -q 'O3 CONTINGENCIA: precondition failed' "$T/ct0.err" && cmp -s <(grep -v '^read_only' "$T/r1.snap") <(grep -v '^read_only' "$T/n2.snap") && pass "N2 step 2 before step 1: refused, state byte-identical" || fail "N2 (rc=$rc)"
o3 contingency "$(U)" > "$T/ct1.log" 2>&1 && pass "o3.sh contingency: both steps exit 0" || { fail "contingency"; tail -5 "$T/ct1.log"; }
snap r2; o3 same "$T/r0.snap" "$T/r2.snap" > "$T/r2.same" && pass "after the contingency the replica is EXACTLY the pre-O3 state ($(grep -c '^PASS' "$T/r2.same") checks)" || { fail "not back to pre"; grep FAIL "$T/r2.same"; }
o3 verdict "$T/r0.snap" "$T/r2.snap" > "$T/v2.out"; [ $? = 0 ] && pass "verdict = REVERTIDO" || fail "verdict clean"
gate O3 restored 16
access "access after the contingency (permissions restored)"
if [ -n "$PID" ]; then b2=$(probe); [ "$b2" = "BASE true $TOT" ] && pass "after the contingency: PR198 behaviour is back" || fail "restored probe [$b2]"; fi
o3 contingency "$(U)" > /dev/null 2>&1 && snap r2b && o3 same "$T/r0.snap" "$T/r2b.snap" > /dev/null && pass "contingency is re-runnable" || fail "contingency second run"

echo "== 5. Fault injection and regressions"
# applied but unregistered (the tool's registry insert is outside the migration's own transaction)
"$PGBIN/psql" "$(U)" -X -q -v ON_ERROR_STOP=1 -f "$R/supabase/migrations/$NAME" >/dev/null 2>&1; snap n3
o3 post "$T/r0.snap" "$T/n3.snap" > "$T/n3.out"; rejects "N3 SQL applied but unregistered: post" 1 "$T/n3.out" "= 64|1|0 (expected 65|1|1)"
grep -q 'PARCIAL_SIN_REGISTRO' <(cls "$T/n3.snap") && pass "classify = PARCIAL_SIN_REGISTRO" || fail "classify n3"
o3 contingency "$(U)" >/dev/null 2>&1; snap n3b; o3 same "$T/r0.snap" "$T/n3b.snap" > /dev/null && pass "contingency from the partial state restores exactly" || fail "n3 restore"
# registry only
LW -d postgres -c "create database regonly template replica" >/dev/null; LW -d regonly -c "insert into public._migrations_applied(name) values ('$NAME')" >/dev/null; snap n7 regonly
grep -q 'PARCIAL_SOLO_REGISTRO' <(cls "$T/n7.snap") && pass "N7 registry row without SQL = PARCIAL_SOLO_REGISTRO" || fail "N7"
# tampered body with the marker kept
LW -d postgres -c "create database tamper template replica" >/dev/null
sed "s/'uncertain operations must be reconciled first'/'uncertain operations must be reconciled'/" "$R/supabase/migrations/$NAME" > "$T/tampered.sql"
"$PGBIN/psql" "$(U tamper)" -X -q -v ON_ERROR_STOP=1 -f "$T/tampered.sql" >/dev/null 2>&1 && LW -d tamper -c "insert into public._migrations_applied(name) values ('$NAME')" >/dev/null; snap n6 tamper
o3 done "$T/n6.snap" > "$T/n6.out"; rejects "N6 tampered body (marker 130000 still t): done" 1 "$T/n6.out" "body (prosrc md5) == migration 56a24ada"
grep -q 'INDETERMINADO' <(cls "$T/n6.snap") && pass "N6 classify = INDETERMINADO" || fail "N6 classify"
# truncated / duplicated snapshots
head -n 12 "$T/r0.snap" > "$T/trunc.snap"; o3 pre "$T/trunc.snap" > "$T/n5.out"; grep -q 'incomplete' "$T/n5.out" && ! grep -q 'RESULT .*: 0 FAIL' "$T/n5.out" && pass "N5 truncated snapshot refused" || fail "N5"
{ cat "$T/r0.snap"; echo "usage_md5|00"; } > "$T/dup.snap"; o3 same "$T/r0.snap" "$T/dup.snap" > "$T/n5b.out"; grep -q 'duplicated: usage_md5' "$T/n5b.out" && pass "N5 duplicated key refused" || fail "N5 dup"
# concurrent change of protected data between pre and post -> post fails on it; contingency -> BLOQUEADO, data kept
snap n8pre
LW -d replica -c "insert into auth.users(id, email) values ('cccccccc-0000-4000-8000-0000000000e4', 'o3c@x') on conflict do nothing; insert into public.podcast_episodes(id, user_id, title, source) values ('e0000000-0000-4000-8000-0000000003b0', 'cccccccc-0000-4000-8000-0000000000e4', 'concurrente', 'upload')" >/dev/null
o3 apply > /dev/null 2>&1 && snap n8post && o3 post "$T/n8pre.snap" "$T/n8post.snap" > "$T/n8.out"; rejects "N8 concurrent podcast change between pre and post: post" 1 "$T/n8.out" "podcast_md5 unchanged"
o3 contingency "$(U)" >/dev/null 2>&1; snap n8after; o3 verdict "$T/n8pre.snap" "$T/n8after.snap" > "$T/v8.out"; rc=$?
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
o3 contingency "$(U)" >/dev/null 2>&1; snap n9b; o3 same "$T/r0.snap" "$T/n9b.snap" >/dev/null || fail "N9 cleanup"
# binding
o3 bind 0000000000000000000000000000000000000000 > "$T/n10.out"; grep -q '^FAIL O3\[bind\] checked-out commit' "$T/n10.out" && pass "N10 bind refuses a different SHA" || fail "N10"
o3 bind "$(git -C "$R" rev-parse HEAD)" > /dev/null && pass "positive: bind accepts the checked-out SHA" || fail "bind positive"

echo "== 6. Repeatability"
o3 apply > /dev/null 2>&1 && snap r6 && o3 post "$T/r0.snap" "$T/r6.snap" > /dev/null && pass "forward path repeatable after the contingency" || fail "forward not repeatable"
d=$(diff <(grep -v '^read_only|' "$T/r1.snap") <(grep -v '^read_only|' "$T/r6.snap") | grep -c '^<'); [ "$d" = 0 ] && pass "second forward identical to the first (every fact)" || fail "second forward differs in $d facts"
echo "RESULT o3-replica: $fails FAIL"
[ $fails = 0 ]
