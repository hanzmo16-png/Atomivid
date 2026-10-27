#!/usr/bin/env bash
# O2 rehearsal on a DISPOSABLE PostgreSQL 17 (USD 0). PRODUCTION IS ONLY READ: the o2.sh snapshot + `pre` checks and the
# tool-connection probe (all inside READ ONLY transactions), then pg_dump with default_transaction_read_only=on. Every
# write goes to the local replica (unix socket, port 55992): `o2.sh apply` runs with SUPABASE_DB_URL = the replica and
# every production credential removed from its environment; `o2.sh contingency` and the probes get the replica URL.
set -uo pipefail
R=$(git rev-parse --show-toplevel); T=$(mktemp -d); PGBIN=/usr/lib/postgresql/17/bin; O2="$R/scripts/qa/schema-readonly/o2.sh"
export OUT=$T; fails=0; pass(){ echo "PASS $*"; }; fail(){ echo "FAIL $*"; fails=$((fails+1)); }
NAME=20261024120000_resume_authorization_ref_match.sql

echo "== 1. Production, READ ONLY: O2 preconditions as the workflow will check them, tool-connection probe, dumps"
PROD=$(cd "$R" && npx tsx -e 'import { resolveConnection } from "./scripts/lib/supabase-db"; const c = resolveConnection(); if (!c) { process.exit(3) } process.stdout.write(c.connectionString)') || { echo "FAIL no DB credential"; exit 1; }
PW=$(node -e 'const u=new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.password))' "$PROD"); echo "::add-mask::$PW"; echo "::add-mask::$PROD"
bash "$O2" snap "$PROD" "$T/prod.snap" > "$T/prod.snaplog" || { cat "$T/prod.snaplog"; echo "FAIL production snapshot"; exit 1; }
bash "$O2" pre "$T/prod.snap" && pass "production meets every O2 precondition right now" || fail "production does not meet the O2 preconditions"
echo "INFO production trigger fn ACL $(grep '^trg_acl|' "$T/prod.snap" | cut -d'|' -f2), RPC ACL $(grep '^rpc_acl|' "$T/prod.snap" | cut -d'|' -f2)"
bash "$O2" probe && pass "production: the tool's own connection (pooler) has statement_timeout=2min (role default), read-only probe" || fail "production statement_timeout differs from 2min"
grep -E '^(jobs_active|jobs_exhausted|other_locks_on_jobs|long_xacts)\|' "$T/prod.snap" | tr '\n' ' ' | sed 's/^/INFO production now: /'; echo
export PGOPTIONS="-c default_transaction_read_only=on"
"$PGBIN/pg_dump" "$PROD" --schema-only --no-owner --no-comments -n public -f "$T/public.sql" 2>/dev/null || { echo "FAIL pg_dump schema"; exit 1; }
"$PGBIN/pg_dump" "$PROD" --data-only --disable-triggers --no-owner -t 'public.pi_*' -t public._migrations_applied -f "$T/data.sql" 2>/dev/null || { echo "FAIL pg_dump data"; exit 1; }
"$PGBIN/pg_dump" "$PROD" --no-owner --no-privileges -n supabase_migrations -f "$T/sm.sql" 2>/dev/null || { echo "FAIL pg_dump registry"; exit 1; }
unset PGOPTIONS PROD PW

echo "== 2. Disposable replica (current post-O1 production state)"
L=$T/local; "$PGBIN/initdb" -D "$L" -U postgres --auth=trust >/dev/null; "$PGBIN/pg_ctl" -D "$L" -o "-p 55992 -k $T -c listen_addresses=''" -l "$T/pg.log" -w start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$L" -m fast stop >/dev/null 2>&1 || true; rm -rf "$T/public.sql" "$T/data.sql" "$T/sm.sql"' EXIT
LW(){ "$PGBIN/psql" -h "$T" -p 55992 -U postgres -X -q "$@"; }   # the ONLY direct write path: local socket
LW -d postgres -c "create database replica" >/dev/null
LW -d replica -f "$R/scripts/harness/e2e/infra/stubs.sql" >/dev/null 2>&1
LW -d replica -c "create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create extension if not exists \"uuid-ossp\" with schema extensions" >/dev/null 2>&1
LW -d replica -f "$T/public.sql" >/dev/null 2>&1; LW -d replica -f "$T/sm.sql" >/dev/null 2>&1; LW -d replica -f "$T/data.sql" >/dev/null 2>&1
U(){ echo "postgresql://postgres@localhost/${1:-replica}?host=$T&port=55992"; }
q(){ LW -d "${2:-replica}" -At -c "$1"; }
[ "$(q 'show port')" = 55992 ] && [ -z "$(q 'select inet_server_port()')" ] && pass "write target is the local socket replica (port 55992, no TCP)" || { fail "write target is not the local replica"; exit 1; }
# the tool resolves its connection from the environment: only the replica URL is left in it
TOOLENV=(env -u SUPABASE_DB_PASSWORD -u SUPABASE_PROJECT_REF -u SUPABASE_URL -u SUPABASE_DB_HOST -u SUPABASE_DB_PORT SUPABASE_DB_URL="$(U)")
o2(){ "${TOOLENV[@]}" bash "$O2" "$@"; }
snap(){ bash "$O2" snap "$(U "${2:-replica}")" "$T/$1.snap" > "$T/$1.snaplog" 2>&1 || { fail "snapshot $1 failed or incomplete: $(grep FAIL "$T/$1.snaplog" | head -2)"; echo "RESULT o2-replica: $fails FAIL (aborted: no check may run on a broken snapshot)"; exit 1; }; }
cls(){ o2 classify "$1" 2>&1 || true; }   # classify exits non-zero for INDETERMINADO by design; the state is in its output
# a NEGATIVE check passes only when the command is rejected for exactly the expected reasons: non-zero exit, every
# expected reason among its FAIL lines, and exactly N FAIL lines (no unrelated failure can make it pass)
rejects(){ local label=$1 n=$2 out=$3; shift 3; local rc=0 f; f=$(grep '^FAIL' "$out"); grep -q '^RESULT .*: 0 FAIL' "$out" && rc=1
  local missing=""; for r in "$@"; do printf '%s\n' "$f" | grep -qF -- "$r" || missing="$missing [$r]"; done
  local c; c=$(printf '%s' "$f" | grep -c '^FAIL')
  [ $rc = 0 ] && [ -z "$missing" ] && [ "$c" = "$n" ] && pass "$label: rejected for exactly the expected $n reason(s)" || { fail "$label: rc_ok=$((1-rc)) missing:${missing:- none} fail_lines=$c (want $n)"; printf '%s\n' "$f" | head -8; }; }
gate(){ local g=0; "${TOOLENV[@]}" GATE_ONLY=1 GATE_NEXT=$1 OUT="$T/gate-$1-$2" bash "$R/scripts/qa/schema-readonly/cierre.sh" > "$T/gate-$1-$2.log" 2>&1 || g=$?
  local n; n=$(grep -c "^PASS GATE\[$1\]" "$T/gate-$1-$2.log"); [ $g = 0 ] && ! grep -q '^FAIL' "$T/gate-$1-$2.log" && [ "$n" = 16 ] && pass "gate $1 on the replica ($2): 16 PASS, 0 FAIL" || { fail "gate $1 on the replica ($2): rc=$g PASS=$n"; grep '^FAIL' "$T/gate-$1-$2.log"; }; }
# the local stubs grant EXECUTE on new functions to anon/authenticated by default; set the two touched functions to the
# ACL production has (read above), so pre/post/same compare against production's real ACL
LW -d replica -c "revoke all on function public.pi_documentary_resume_requires_budget() from public, anon, authenticated; grant execute on function public.pi_documentary_resume_requires_budget() to service_role; revoke all on function public.pi_recovery_resume_authorization(text,text) from public, anon, authenticated; grant execute on function public.pi_recovery_resume_authorization(text,text) to service_role"
LW -d replica -c "alter role postgres set statement_timeout = '2min'"   # production's role default (probe above)
# same for the durable-authorization table the PR198 trigger reads (production: closed to every client role)
LW -d replica -c "revoke all on public.pi_recovery_resume_authorizations from public, anon, authenticated, service_role"
for k in acl_pi_recovery_resume_authorizations acl_pi_recovery_budgets acl_documentary_script_jobs; do echo "INFO $k production=$(grep "^$k|" "$T/prod.snap" | cut -d'|' -f2) replica=$(bash "$O2" snap "$(U)" "$T/acl.snap" >/dev/null; grep "^$k|" "$T/acl.snap" | cut -d'|' -f2)"; done
snap r0; o2 pre "$T/r0.snap" > "$T/r0.pre" && pass "replica meets the O2 preconditions (63 registered, 548 / 41, markers t f f f, ACLs)" || { fail "replica pre"; grep FAIL "$T/r0.pre"; }
same=1; for k in ma_count ma_md5_without_o2 sm_md5 pi_paid_operations open_operations pi_rows m000 m120 m130 m140 trg_src_md5 trg_def_md5 trg_attr trg_acl rpc_src_md5 rpc_def_md5 rpc_attr rpc_acl exec_trg exec_rpc trigger_def acl_pi_recovery_resume_authorizations; do
  [ "$(grep "^$k|" "$T/r0.snap")" = "$(grep "^$k|" "$T/prod.snap")" ] || { same=0; fail "replica differs from production in $k"; }; done
[ $same = 1 ] && pass "replica == production in registries, pi_* row counts, markers, both bodies (prosrc + functiondef md5), attributes, ACLs, EXECUTE and the full trigger definition"
gate O2 before

# behaviour probe as the app (service_role): synthetic exhausted job with an ACTIVE budget (ref A) — always rolled back
probe(){ # $1 durable ref ("" = none) -> prints the outcome of the app's requeue UPDATE
  LW -d replica -At 2>&1 <<SQL | grep -E 'BUDGET|UPDATED|ERROR' | grep -v '^BUDGET true$' | sed 's/^.*ERROR: *//' | head -1
begin;
insert into auth.users(id, email) values ('cccccccc-0000-4000-8000-0000000000c2', 'o2@x') on conflict do nothing;
insert into public.documentary_script_jobs(id, user_id, input_hash, topic, status, retry_count) values ('d0000000-0000-4000-8000-0000000002a0', 'cccccccc-0000-4000-8000-0000000000c2', 'h-o2', 'o2', 'failed', 3);
select 'BUDGET ' || (public.pi_open_recovery_budget('d0000000-0000-4000-8000-0000000002a0', 'documentary:cccccccc-0000-4000-8000-0000000000c2:o2', 0.60, 'ref-A')->>'opened');
$( [ -n "$1" ] && echo "insert into public.pi_recovery_resume_authorizations(project_id, authorization_ref) values ('documentary:cccccccc-0000-4000-8000-0000000000c2:o2', '$1');" )
set local role service_role;
with u as (update public.documentary_script_jobs set status = 'queued' where id = 'd0000000-0000-4000-8000-0000000002a0' and status = 'failed' returning 1) select 'UPDATED ' || count(*) from u;
rollback;
SQL
}
behave(){ local ab aa none; ab=$(probe ref-B); aa=$(probe ref-A); none=$(probe ""); echo "INFO $1: A/B -> [$ab]  A/A -> [$aa]  no durable row -> [$none]"
  case "$2" in
    old) [ "$(printf '%s\n' "$ab" "$aa" "$none" | grep -c 'permission denied for table pi_recovery_resume_authorizations')" = 3 ] && pass "$1: PR198 trigger refuses every requeue from service_role (permission denied, fail-closed)" || fail "$1: unexpected PR198 behaviour";;
    new) [ "$aa" = "UPDATED 1" ] && echo "$ab" | grep -q 'same project_id and authorization_ref' && echo "$none" | grep -q 'spend authorization required' && pass "$1: A/A requeues (1 row), A/B and no-durable-row refused by the trigger (P0001)" || fail "$1: unexpected 120000 behaviour";;
  esac; }
behave "before O2" old
[ "$(q "select count(*) from public.documentary_script_jobs where id = 'd0000000-0000-4000-8000-0000000002a0'")" = 0 ] && pass "behaviour probes left no row behind (rolled back)" || fail "probe row persisted"

echo "== 3. O2 on the replica exactly as the workflow runs it: o2.sh apply (real tool, one file), then post checks"
o2 apply > "$T/apply1.log" 2>&1 && pass "o2.sh apply: exit 0, tool summary '1 aplicada [$NAME], 0 reconciliadas'" || { fail "o2.sh apply"; tail -5 "$T/apply1.log"; }
grep -E 'Aplicando|aplicada y confirmada|Resumen|WARNING|aviso' "$T/apply1.log" | sed 's/^/  /'
snap r1; o2 post "$T/r0.snap" "$T/r1.snap" > "$T/r1.post" && pass "o2.sh post: every post-O2 check passes ($(grep -c '^PASS' "$T/r1.post") checks)" || { fail "o2.sh post"; grep FAIL "$T/r1.post"; }
gate O3 after
behave "after O2" new
o2 pre "$T/r1.snap" > "$T/n1.out"
rejects "N1 second run on the post-O2 state stops at 'pre'" 7 "$T/n1.out" "_migrations_applied rows" "markers 000000" "trigger fn body (prosrc md5 | functiondef md5) == PR198" "RPC body (prosrc md5 | functiondef md5) == PR198" "trigger fn lang" "ACL trigger fn | RPC" "EXECUTE trigger fn | RPC"
o2 done "$T/r1.snap" > "$T/p1.out" && pass "positive: 'done' (audited post-O2 references, absolute) passes on the post-O2 state" || { fail "done on post state"; grep FAIL "$T/p1.out"; }
cls "$T/r1.snap" | grep -q 'O2 STATE: COMPLETADO' && pass "classify post-O2 state = COMPLETADO" || fail "classify post state"
cls "$T/r0.snap" | grep -q 'O2 STATE: PRE' && pass "classify pre-O2 state = PRE" || fail "classify pre state"
o2 apply > "$T/apply2.log" 2>&1; grep -q 'ya está registrada como aplicada' "$T/apply2.log" && grep -q 'Resumen: 0 aplicada' "$T/apply2.log" && pass "re-running the tool: skipped as registered, 0 applied" || fail "tool re-run did not skip"
snap r1b; o2 post "$T/r0.snap" "$T/r1b.snap" > /dev/null && cmp -s <(grep -v '^read_only' "$T/r1.snap") <(grep -v '^read_only' "$T/r1b.snap") && pass "re-run changed nothing (complete snapshots identical, post still passes)" || fail "re-run changed state"

echo "== 4. Contingency (the workflow's recovery path)"
LW -d postgres -c "create database onlyrb template replica" >/dev/null
"$PGBIN/psql" "$(U onlyrb)" -X -q -v ON_ERROR_STOP=1 -f "$R/supabase/proposals/${NAME%.sql}.rollback.sql" >/dev/null 2>&1; snap rb onlyrb
bash "$O2" same "$T/r0.snap" "$T/rb.snap" > "$T/rb.same"
rejects "N4 audited rollback ALONE is not a full restore (service_role grant + registry row)" 6 "$T/rb.same" "ACL trigger fn | RPC" "EXECUTE trigger fn | RPC" "ma_count unchanged" "ma_has_o2 unchanged" "trg_acl unchanged" "exec_trg unchanged"
cls "$T/rb.snap" | grep -q 'O2 STATE: INDETERMINADO' && pass "classify after rollback alone = INDETERMINADO (bodies PR198, ACL not, registry row present)" || fail "classify rollback-only state: $(cls "$T/rb.snap")"
"$PGBIN/psql" "$(U replica)" -X -q -v ON_ERROR_STOP=1 -f "$R/docs/ops/o2/O2_contingencia_registro.sql" > /dev/null 2> "$T/ct0.err"; rc=$?; snap n2
[ $rc != 0 ] && grep -q 'O2 CONTINGENCIA: precondition failed — run the 120000 rollback (step 1) first' "$T/ct0.err" && cmp -s <(grep -v '^read_only' "$T/r1.snap") <(grep -v '^read_only' "$T/n2.snap") \
  && pass "N2 step 2 before step 1: refused with its own precondition error, state byte-identical (registry row and grant untouched)" || { fail "N2 step 2 before step 1 (rc=$rc): $(head -2 "$T/ct0.err")"; }
o2 contingency "$(U)" > "$T/ct1.log" 2>&1 && pass "o2.sh contingency: both steps exit 0" || { fail "contingency"; tail -5 "$T/ct1.log"; }
snap r2; o2 same "$T/r0.snap" "$T/r2.snap" > "$T/r2.same" && pass "after the contingency the replica is EXACTLY the pre-O2 state ($(grep -c '^PASS' "$T/r2.same") checks: audited PR198 bodies/attributes/ACL/trigger, registry, jobs, pi_* data, other objects)" || { fail "not back to pre"; grep FAIL "$T/r2.same"; }
o2 verdict "$T/r0.snap" "$T/r2.snap" > "$T/v2.out"; [ $? = 0 ] && grep -q 'REVERTIDO' "$T/v2.out" && pass "verdict after a clean contingency = REVERTIDO" || fail "verdict clean: $(tail -1 "$T/v2.out")"
gate O2 restored
behave "after contingency" old
o2 contingency "$(U)" > "$T/ct2.log" 2>&1 && snap r2b && o2 same "$T/r0.snap" "$T/r2b.snap" > /dev/null && pass "contingency is re-runnable (second run: still exactly pre-O2)" || fail "contingency second run"

echo "== 5. Fault injection"
# (a) production gives the tool no lock_timeout (the pooler drops it): another session holding a lock makes the tool WAIT.
#     a1: a short holder (8 s): the tool waits, then completes normally.  a2: a holder longer than statement_timeout
#     (set to 6 s on this replica only, to keep the run short): the server cancels the tool, which rolls back cleanly.
hold(){ ( PGOPTIONS="-c statement_timeout=0" LW -d replica -c "begin; lock table public.documentary_script_jobs in access share mode; select pg_sleep($1); commit;" >/dev/null 2>&1 ) & H=$!; sleep 1; }
hold 8; t0=$(date +%s); o2 apply > "$T/apply3.log" 2>&1; rc=$?; t1=$(date +%s); wait $H 2>/dev/null
snap r3; [ $rc = 0 ] && [ $((t1 - t0)) -ge 5 ] && o2 post "$T/r0.snap" "$T/r3.snap" > /dev/null && pass "a1 lock held 8 s: tool waited $((t1 - t0)) s, then applied; post passes" || { fail "a1: rc=$rc $((t1 - t0)) s"; tail -3 "$T/apply3.log"; }
o2 contingency "$(U)" >/dev/null 2>&1; snap r3b; o2 same "$T/r0.snap" "$T/r3b.snap" > /dev/null || fail "a1 cleanup"
LW -d replica -c "alter role postgres set statement_timeout = '6s'"; hold 20
t0=$(date +%s); o2 apply > "$T/apply3b.log" 2>&1; rc=$?; t1=$(date +%s); kill $H 2>/dev/null; wait $H 2>/dev/null
LW -d replica -c "alter role postgres set statement_timeout = '2min'"
grep -q 'statement timeout' "$T/apply3b.log" && [ $rc != 0 ] && pass "a2 lock held longer than statement_timeout: server cancelled the tool after $((t1 - t0)) s (exit $rc)" || { fail "a2: rc=$rc"; tail -3 "$T/apply3b.log"; }
snap r3c; o2 same "$T/r0.snap" "$T/r3c.snap" > /dev/null && cls "$T/r3c.snap" | grep -q 'O2 STATE: PRE' && pass "a2 after the cancelled attempt the replica is exactly pre-O2 (classify PRE: nothing to revert, report BLOQUEADO)" || fail "a2 cancelled attempt changed state"
# (b) the migration's own COMMIT ends the tool's transaction, so the registry insert is separate: simulate 'SQL committed,
#     row missing' and prove post fails and the contingency still restores the exact pre-O2 state
"$PGBIN/psql" "$(U)" -X -q -v ON_ERROR_STOP=1 -f "$R/supabase/migrations/$NAME" >/dev/null 2>&1; snap r4
o2 post "$T/r0.snap" "$T/r4.snap" > "$T/n3.out"
rejects "N3 SQL applied but unregistered: post" 1 "$T/n3.out" "_migrations_applied rows | $NAME registered = 63|0 (expected 64|1)"
cls "$T/r4.snap" | grep -q 'O2 STATE: PARCIAL_SIN_REGISTRO' && pass "classify = PARCIAL_SIN_REGISTRO" || fail "classify unregistered state"
o2 contingency "$(U)" >/dev/null 2>&1; snap r5; o2 same "$T/r0.snap" "$T/r5.snap" > /dev/null && pass "contingency from 'applied but unregistered' restores exactly pre-O2" || fail "contingency from partial state"
# (c) the tool's two transactions, measured on the replica's logged statements: the file's own begin/commit commits the DDL
grep -c 'there is already a transaction in progress\|there is no transaction in progress' "$T/pg.log" | sed 's/^/INFO server warnings for nested BEGIN or extra COMMIT during the rehearsal: /'

echo "== 5b. Regressions required by CORRECCION-1"
# N5 truncated / broken snapshot: every check must refuse it (the old false PASS 're-run changed nothing' came from this)
head -c 400 "$T/r0.snap" > "$T/trunc.snap"
for c in pre done; do o2 $c "$T/trunc.snap" > "$T/n5$c.out"; grep -q "^FAIL O2\[$c\] snapshot .* incomplete" "$T/n5$c.out" && ! grep -q '^RESULT .*: 0 FAIL' "$T/n5$c.out" && pass "N5 $c refuses a truncated snapshot" || fail "N5 $c accepted a truncated snapshot"; done
for c in post same; do o2 $c "$T/r0.snap" "$T/trunc.snap" > "$T/n5$c.out"; grep -q "incomplete" "$T/n5$c.out" && ! grep -q '^RESULT .*: 0 FAIL' "$T/n5$c.out" && pass "N5 $c refuses a truncated snapshot" || fail "N5 $c accepted a truncated snapshot"; done
cls "$T/trunc.snap" | grep -q 'O2 STATE: INDETERMINADO' && pass "N5 classify of a truncated snapshot = INDETERMINADO" || fail "N5 classify truncated"
# N6 a body that differs from the audited migration (same marker text) must not pass 'done' / 'post'
LW -d postgres -c "create database tamper template replica" >/dev/null
sed 's/needs an ACTIVE recovery budget/needs an active recovery budget/' "$R/supabase/migrations/$NAME" > "$T/tampered.sql"
"$PGBIN/psql" "$(U tamper)" -X -q -v ON_ERROR_STOP=1 -f "$T/tampered.sql" >/dev/null 2>&1 && LW -d tamper -c "insert into public._migrations_applied(name) values ('$NAME')" >/dev/null; snap n6 tamper
o2 done "$T/n6.snap" > "$T/n6.out"; rejects "N6 tampered trigger body (marker still t): done" 1 "$T/n6.out" "trigger fn body (prosrc md5) == migration 13dffaa6"
cls "$T/n6.snap" | grep -q 'O2 STATE: INDETERMINADO' && pass "N6 classify tampered = INDETERMINADO" || fail "N6 classify"
# N7 registry row without the SQL
LW -d postgres -c "create database regonly template replica" >/dev/null; LW -d regonly -c "insert into public._migrations_applied(name) values ('$NAME')" >/dev/null; snap n7 regonly
o2 post "$T/r0.snap" "$T/n7.snap" > "$T/n7.out"; [ "$(grep -c '^FAIL' "$T/n7.out")" -ge 5 ] && grep -qF "trigger fn body (prosrc md5) == migration" "$T/n7.out" && pass "N7 registry row without SQL: post rejected (bodies are PR198)" || fail "N7 post accepted registry-only"
cls "$T/n7.snap" | grep -q 'O2 STATE: PARCIAL_SOLO_REGISTRO' && pass "N7 classify = PARCIAL_SOLO_REGISTRO" || fail "N7 classify"
# N8 concurrent change of a documentary job between pre and post: post must fail on jobs_md5 only; the contingency undoes
#    O2 exactly and the verdict is BLOQUEADO with the concurrent job left exactly as written (never overwritten)
snap n8pre
LW -d replica -c "insert into auth.users(id, email) values ('cccccccc-0000-4000-8000-0000000000c3', 'o2c@x') on conflict do nothing; insert into public.documentary_script_jobs(id, user_id, input_hash, topic, status, retry_count) values ('d0000000-0000-4000-8000-0000000002b0', 'cccccccc-0000-4000-8000-0000000000c3', 'h-o2c', 'o2c', 'failed', 1)" >/dev/null
J8=$(q "select status || ':' || retry_count || ':' || updated_at from public.documentary_script_jobs where id = 'd0000000-0000-4000-8000-0000000002b0'")
o2 apply > "$T/apply8.log" 2>&1 && snap n8post && o2 post "$T/n8pre.snap" "$T/n8post.snap" > "$T/n8.out"
rejects "N8 concurrent job change between pre and post: post" 1 "$T/n8.out" "jobs_md5 unchanged"
o2 contingency "$(U)" > "$T/ct8.log" 2>&1 || fail "N8 contingency"; snap n8after
o2 verdict "$T/n8pre.snap" "$T/n8after.snap" > "$T/v8.out"; rc=$?
[ $rc = 3 ] && grep -q 'O2 VERDICT: BLOQUEADO' "$T/v8.out" && [ "$(grep -c '^FAIL' "$T/v8.out")" = 1 ] && grep -q 'jobs_md5 unchanged' "$T/v8.out" && pass "N8 verdict after contingency = BLOQUEADO (exit 3): O2 undone exactly, only the concurrent job differs" || { fail "N8 verdict rc=$rc"; cat "$T/v8.out"; }
cls "$T/n8after.snap" | grep -q 'O2 STATE: PRE' && pass "N8 O2 objects are back to PR198 (classify PRE)" || fail "N8 classify"
[ "$(q "select status || ':' || retry_count || ':' || updated_at from public.documentary_script_jobs where id = 'd0000000-0000-4000-8000-0000000002b0'")" = "$J8" ] && pass "N8 the concurrent job is untouched (status, retry_count, updated_at as written)" || fail "N8 concurrent job was modified"
LW -d replica -c "delete from public.documentary_script_jobs where id = 'd0000000-0000-4000-8000-0000000002b0'" >/dev/null   # rehearsal cleanup, replica only
snap n8clean; o2 same "$T/r0.snap" "$T/n8clean.snap" > /dev/null && pass "N8 replica back to the exact pre-O2 state after removing the synthetic job" || fail "N8 cleanup"
# N9 contingency step 1 fails (lock held past statement_timeout during the rollback): step 2 must NOT run
o2 apply > "$T/apply9.log" 2>&1 || fail "N9 setup apply"
LW -d replica -c "alter role postgres set statement_timeout = '6s'"; hold 20
o2 contingency "$(U)" > "$T/ct9.log" 2>&1; rc=$?; kill $H 2>/dev/null; wait $H 2>/dev/null; LW -d replica -c "alter role postgres set statement_timeout = '2min'"; snap n9
[ $rc != 0 ] && grep -q 'step 1 failed: STOP, step 2 NOT run' "$T/ct9.log" && ! grep -q 'step 2:' "$T/ct9.log" && [ "$(grep '^ma_has_o2|' "$T/n9.snap" | cut -d'|' -f2)" = 1 ] \
  && pass "N9 step 1 failed: contingency stopped, step 2 not run (registry row still there)" || { fail "N9 rc=$rc"; tail -4 "$T/ct9.log"; }
cls "$T/n9.snap" | grep -q 'O2 STATE: COMPLETADO' && pass "N9 classify after the failed step 1 = COMPLETADO (rollback rolled back as a whole)" || fail "N9 classify: $(cls "$T/n9.snap")"
o2 contingency "$(U)" >/dev/null 2>&1; snap n9b; o2 same "$T/r0.snap" "$T/n9b.snap" > /dev/null || fail "N9 cleanup"
# N10 binding to the authorized SHA
o2 bind 0000000000000000000000000000000000000000 > "$T/n10.out"; grep -q '^FAIL O2\[bind\] checked-out commit == authorized SHA' "$T/n10.out" && ! grep -q '^RESULT .*: 0 FAIL' "$T/n10.out" && pass "N10 bind refuses a different SHA" || fail "N10 bind accepted a wrong SHA"
o2 bind "$(git -C "$R" rev-parse HEAD)" > /dev/null && pass "positive: bind accepts the checked-out SHA (== GITHUB_SHA)" || fail "bind positive"

echo "== 6. Repeatability: forward again from the restored state"
o2 apply > "$T/apply4.log" 2>&1 && snap r6 && o2 post "$T/r0.snap" "$T/r6.snap" > /dev/null && pass "forward path repeatable after the contingency (post passes)" || fail "forward not repeatable"
d=$(diff <(grep -vE '^(read_only)\|' "$T/r1.snap") <(grep -vE '^(read_only)\|' "$T/r6.snap") | grep -c '^<'); [ "$d" = 0 ] && pass "second forward result identical to the first (every fact of two complete snapshots)" || fail "second forward differs in $d facts"

echo "RESULT o2-replica: $fails FAIL"
[ $fails = 0 ]
