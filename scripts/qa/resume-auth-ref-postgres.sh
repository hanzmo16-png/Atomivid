#!/usr/bin/env bash
# USD 0. Disposable PostgreSQL verification of supabase/proposals/20261024120000_resume_authorization_ref_match.sql
# (P0 T-20261024-0724-chatgpt-02: requeue requires exact project_id + authorization_ref + non-empty transaction_id).
# Runs AFTER scripts/qa/spend-authorization-postgres.sh (PR198 proposal applied). Never production; no providers.
# Usage: PGHOST=<socket dir> PGPORT=<port> DB=<db> bash scripts/qa/resume-auth-ref-postgres.sh
set -uo pipefail
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
BASE=$R/supabase/proposals/20261024000000_spend_authorizations.sql
MIG=$R/supabase/proposals/20261024120000_resume_authorization_ref_match.sql; RB=${MIG%.sql}.rollback.sql
DB=${DB:-atomivid}; Q="psql -U postgres -d $DB -v ON_ERROR_STOP=1 -qAt"; SR="psql -U postgres -d $DB -qAt"
FAILS=0; ok(){ echo "PASS $*"; }; bad(){ echo "FAIL $*"; FAILS=$((FAILS+1)); }
eq(){ [ "$1" = "$2" ] && ok "$3" || bad "$3 (got '$1', want '$2')"; }
case "$DB" in *prod*|postgres) echo "refusing DB $DB"; exit 2;; esac

U=cccccccc-0000-4000-8000-0000000000c1
REF_A=hans-budget-ref-A; REF_B=hans-durable-ref-B
$Q -c "insert into auth.users(id,email) values ('$U','p0@x') on conflict do nothing"
$Q -f "$BASE" >/dev/null 2>&1 || { echo "FAIL PR198 base proposal did not apply"; exit 1; }

mkjob() { # job_id project ref -> failed exhausted job + ACTIVE budget with ref
  $Q -c "insert into public.documentary_script_jobs(id,user_id,input_hash,topic,status,retry_count) values ('$1','$U','h-$1','p0','failed',3)"
  eq "$($Q -c "select public.pi_open_recovery_budget('$1','$2',0.60,'$3')->>'opened'")" true "setup budget $2 ref $3 ACTIVE"; }
durable() { $Q -c "insert into public.pi_recovery_resume_authorizations(project_id,authorization_ref) values ('$1','$2')"; }
# Exactly what script-job-resume.ts does (optimistic: status='failed' and updated_at unchanged), as service_role.
app_requeue() { $SR -c "set role service_role; update public.documentary_script_jobs set status='queued', run_token=null, failure_kind=null, error_code=null, error_message=null, stage='En cola', updated_at=clock_timestamp() where id='$1' and status='failed' and updated_at='$2' returning 1" 2>&1; }
snap() { $Q -c "select j.status||'|'||j.xmin||'|'||j.updated_at||'|'||(select count(*) from public.pi_paid_operations o where o.project_id='$2')||'|'||(select count(*) from public.pi_paid_operations)||'|'||(select count(*) from public.pi_paid_operations o where o.project_id='$2' and o.status in ('SUBMITTED','PROVIDER_JOB_RECORDED'))||'|'||(select status||cap_usd from public.pi_recovery_budgets where job_id=j.id) from public.documentary_script_jobs j where j.id='$1'"; }
ab_rejected() { # job project label
  local before after ua out; before=$(snap "$1" "$2"); ua=$($Q -c "select updated_at from public.documentary_script_jobs where id='$1'")
  $Q -c "update public.documentary_script_jobs set status='queued' where id='$1'" >/dev/null 2>&1 && bad "$3 postgres UPDATE accepted" || ok "$3 rejected for direct SQL (postgres)"
  out=$(app_requeue "$1" "$ua"); echo "$out" | grep -q "spend authorization required" && ok "$3 rejected for app path (service_role): trigger raised" || bad "$3 app path ($out)"
  after=$(snap "$1" "$2"); eq "$after" "$before" "$3 job/accounting snapshot identical (status|xmin|updated_at|ops project|ops total|submitted|budget)"
  eq "${after%%|*}" failed "$3 status stays failed"
  eq "$(echo "$after" | cut -d'|' -f4)" 0 "$3 0 accounting ops for the project"
  eq "$(echo "$after" | cut -d'|' -f6)" 0 "$3 0 SUBMITTED/provider POSTs for the project (global op count unchanged in snapshot)"; }
acl() { # label
  eq "$($Q -c "select prosecdef||' '||array_to_string(proconfig,',')||' '||pg_get_userbyid(proowner) from pg_proc where oid='public.pi_recovery_resume_authorization(text,text)'::regprocedure")" 'true search_path="" postgres' "$1 RPC SECURITY DEFINER, search_path='', owner postgres"
  eq "$($Q -c "select string_agg(r||'='||has_function_privilege(r,'public.pi_recovery_resume_authorization(text,text)','EXECUTE'),' ' order by r) from unnest(array['anon','authenticated','service_role']) r")" "anon=false authenticated=false service_role=true" "$1 RPC has_function_privilege"
  eq "$($Q -c "select string_agg(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,',' order by 1) from pg_proc p, aclexplode(p.proacl) a where p.oid='public.pi_recovery_resume_authorization(text,text)'::regprocedure and a.privilege_type='EXECUTE'")" "postgres,service_role" "$1 RPC proacl EXECUTE = {postgres, service_role} only"
  eq "$($Q -c "select count(*) from pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='public.pi_recovery_resume_authorization(text,text)'::regprocedure and a.grantee in (0,'anon'::regrole,'authenticated'::regrole)")" 0 "$1 RPC no PUBLIC/anon/authenticated grant"
  for r in anon authenticated; do out=$($SR -c "set role $r; select public.pi_recovery_resume_authorization('x','y')" 2>&1)
    echo "$out" | grep -q "permission denied" && ok "$1 $r calling RPC => permission denied" || bad "$1 $r executed RPC ($out)"; done; }

echo "== R00 bug reproduced on PR198 (762714e) before the fix: A/B passes the trigger (probe rolled back)"
J0=d0000000-0000-4000-8000-000000000000; P0=documentary:$U:r00; mkjob $J0 $P0 $REF_A; durable $P0 $REF_B
eq "$($Q -c "begin; update public.documentary_script_jobs set status='queued' where id='$J0' returning 1; rollback;" 2>&1 | head -1)" 1 "R00 PRE-FIX bypass confirmed (budget ref A + durable ref B requeues)"
eq "$($Q -c "select status from public.documentary_script_jobs where id='$J0'")" failed "R00 probe rolled back"

echo "== R01 apply fix (twice: re-runnable)"
$Q -f "$MIG" >/dev/null && $Q -f "$MIG" >/dev/null && ok "R01 proposal applies and re-applies" || bad "R01 apply"

echo "== R02 T10c A/B: budget ref A + durable ref B => rejected before the job mutates"
ab_rejected $J0 $P0 "R02 A/B"
echo "== R03 durable row for ANOTHER project with ref A does not count"
J3=d0000000-0000-4000-8000-000000000003; P3=documentary:$U:r03; mkjob $J3 $P3 $REF_A
J3X=d0000000-0000-4000-8000-0000000000f3; P3X=documentary:$U:r03x; mkjob $J3X $P3X $REF_B; durable $P3X $REF_A
ab_rejected $J3 $P3 "R03 cross-project"
echo "== R04 no durable row at all (e8048599 production shape)"
J4=d0000000-0000-4000-8000-000000000004; P4=documentary:$U:r04; mkjob $J4 $P4 $REF_A
ab_rejected $J4 $P4 "R04 no durable authorization"
$Q -c "insert into public.pi_recovery_resume_authorizations(project_id,authorization_ref,transaction_id) values ('$P4','$REF_A',null)" >/dev/null 2>&1 && bad "R04 null transaction_id stored" || ok "R04 transaction_id NULL cannot be stored (NOT NULL)"
echo "== R05 A/A but budget CLOSED => rejected"
J5=d0000000-0000-4000-8000-000000000005; P5=documentary:$U:r05; mkjob $J5 $P5 $REF_A; durable $P5 $REF_A
$Q -c "update public.pi_recovery_budgets set status='CLOSED', closed_at=now() where project_id='$P5'"
ab_rejected $J5 $P5 "R05 closed budget"

echo "== R06 RPC exact match"
rpc(){ $SR -c "set role service_role; select public.pi_recovery_resume_authorization($1)->>'authorized'"; }
eq "$(rpc "'$P0','$REF_A'")" false "R06 RPC A/B (project r00, ref A) => false"
eq "$(rpc "'$P0','$REF_B'")" true "R06 RPC exact (project, ref B, tx) => true"
eq "$(rpc "'$P0',''")" false "R06 RPC empty ref => false"; eq "$(rpc "'','$REF_B'")" false "R06 RPC empty project => false"
eq "$(rpc "null,null")" false "R06 RPC nulls => false"

echo "== R07 valid A/A through the app path (service_role): exactly one transition"
J7=d0000000-0000-4000-8000-000000000007; P7=documentary:$U:r07; mkjob $J7 $P7 $REF_A; durable $P7 $REF_A
UA=$($Q -c "select updated_at from public.documentary_script_jobs where id='$J7'")
eq "$(app_requeue $J7 "$UA" | grep -c '^1$')" 1 "R07 A/A requeue: 1 row updated"
eq "$($Q -c "select status from public.documentary_script_jobs where id='$J7'")" queued "R07 status queued"
eq "$(app_requeue $J7 "$UA" | grep -c '^1$')" 0 "R07 repeated request: 0 rows (no second transition)"
eq "$($Q -c "select count(*) from public.pi_paid_operations where project_id='$P7'")" 0 "R07 requeue itself creates 0 accounting ops / 0 provider POSTs"

echo "== R08 concurrency: two simultaneous A/A requests, only one wins"
J8=d0000000-0000-4000-8000-000000000008; P8=documentary:$U:r08; mkjob $J8 $P8 $REF_A; durable $P8 $REF_A
UA=$($Q -c "select updated_at from public.documentary_script_jobs where id='$J8'"); X0=$($Q -c "select xmin from public.documentary_script_jobs where id='$J8'")
UPD="update public.documentary_script_jobs set status='queued', stage='En cola', updated_at=clock_timestamp() where id='$J8' and status='failed' and updated_at='$UA' returning 1"
( $SR -c "set role service_role; begin; $UPD; select pg_sleep(2); commit;" > /tmp/r08A.out 2>&1 ) &
sleep 0.5; T0=$(date +%s.%N); ( $SR -c "set role service_role; $UPD;" > /tmp/r08B.out 2>&1 ); T1=$(date +%s.%N); wait
A=$(grep -c '^1$' /tmp/r08A.out); B=$(grep -c '^1$' /tmp/r08B.out); echo "  A=[$(tr '\n' ' ' </tmp/r08A.out)] B=[$(tr '\n' ' ' </tmp/r08B.out)] B waited $(python3 -c "print(round($T1-$T0,2))")s"
eq "$((A+B))" 1 "R08 exactly one of two concurrent requests transitioned the job"
eq "$A$B" 10 "R08 the first holder wins; the second sees 0 rows after the lock (no error, no double transition)"
python3 -c "import sys; sys.exit(0 if $T1-$T0 > 1.0 else 1)" && ok "R08 second request blocked on the row lock until the first committed" || bad "R08 no lock wait"
eq "$($Q -c "select status from public.documentary_script_jobs where id='$J8'")" queued "R08 final status queued"
[ "$($Q -c "select xmin from public.documentary_script_jobs where id='$J8'")" != "$X0" ] && ok "R08 one row version written" || bad "R08 xmin unchanged"
echo "== R08b concurrent A/B + A/B (different job): both rejected"
J9=d0000000-0000-4000-8000-000000000009; P9=documentary:$U:r09; mkjob $J9 $P9 $REF_A; durable $P9 $REF_B
UA=$($Q -c "select updated_at from public.documentary_script_jobs where id='$J9'")
( app_requeue $J9 "$UA" > /tmp/r09A.out ) & ( app_requeue $J9 "$UA" > /tmp/r09B.out ) & wait
eq "$(cat /tmp/r09A.out /tmp/r09B.out | grep -c 'spend authorization required')" 2 "R08b both concurrent A/B requests raised"
eq "$($Q -c "select status from public.documentary_script_jobs where id='$J9'")" failed "R08b status stays failed"

echo "== R09 unchanged: normal «Reintentar» (retry_count < 3) needs no budget"
JN=d0000000-0000-4000-8000-00000000000a
$Q -c "insert into public.documentary_script_jobs(id,user_id,input_hash,topic,status,retry_count) values ('$JN','$U','hn','x','failed',1)"
$Q -c "update public.documentary_script_jobs set status='queued', retry_count=2 where id='$JN'" >/dev/null 2>&1 && ok "R09 normal retry unchanged" || bad "R09 normal retry blocked"

echo "== R10 security contract after apply"
acl "R10"
eq "$($Q -c "select prosecdef||' '||array_to_string(proconfig,',')||' '||pg_get_userbyid(proowner) from pg_proc where oid='public.pi_documentary_resume_requires_budget()'::regprocedure")" 'true search_path="" postgres' "R10 trigger fn SECURITY DEFINER, search_path='', owner postgres"
eq "$($Q -c "select string_agg(r||'='||has_function_privilege(r,'public.pi_documentary_resume_requires_budget()','EXECUTE'),' ' order by r) from unnest(array['anon','authenticated','service_role']) r")" "anon=false authenticated=false service_role=false" "R10 trigger fn not callable by any client role"
eq "$($Q -c "select count(*) from pg_trigger where tgname='pi_documentary_resume_requires_budget' and tgrelid='public.documentary_script_jobs'::regclass and tgenabled='O'")" 1 "R10 trigger installed and enabled"

echo "== R11 rollback (twice), then re-apply"
$Q -f "$RB" >/dev/null && $Q -f "$RB" >/dev/null && ok "R11 rollback applies and re-applies" || bad "R11 rollback"
eq "$($Q -c "select prosecdef from pg_proc where oid='public.pi_documentary_resume_requires_budget()'::regprocedure")" f "R11 PR198 trigger body restored (invoker)"
eq "$($Q -c "begin; update public.documentary_script_jobs set status='queued' where id='$J0' returning 1; rollback;" 2>&1 | head -1)" 1 "R11 after rollback the A/B bypass is back (proves the test detects the bug; probe rolled back)"
acl "R11 after rollback"
JI=d0000000-0000-4000-8000-0000000000ee; PI=documentary:$U:rinfo; mkjob $JI $PI $REF_A; durable $PI $REF_A
UA=$($Q -c "select updated_at from public.documentary_script_jobs where id='$JI'")
echo "  INFO PR198 (invoker) trigger, valid A/A via service_role app path => [$($SR -c "set role service_role; begin; update public.documentary_script_jobs set status='queued' where id='$JI' and updated_at='$UA' returning 1; rollback;" 2>&1 | tr '\n' ' ')]"
$Q -f "$MIG" >/dev/null && ok "R11 re-apply after rollback" || bad "R11 re-apply"
ab_rejected $J0 $P0 "R11 A/B after re-apply"
acl "R11 after re-apply"
eq "$($Q -c "select prosecdef||' '||array_to_string(proconfig,',')||' '||pg_get_userbyid(proowner)||' sr='||has_function_privilege('service_role','public.pi_documentary_resume_requires_budget()','EXECUTE') from pg_proc where oid='public.pi_documentary_resume_requires_budget()'::regprocedure")" 'true search_path="" postgres sr=false' "R11 trigger fn contract after re-apply"

echo "RESULT $([ $FAILS = 0 ] && echo ALL PASS || echo "$FAILS FAIL")"
exit $FAILS
