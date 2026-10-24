#!/usr/bin/env bash
# USD 0. Real disposable PostgreSQL verification of supabase/proposals/20261024000000_spend_authorizations.sql.
# Requires a database built from the repo migrations (same as scripts/harness/e2e/infra/setup.sh). Never production.
# Usage: PGHOST=<socket dir> PGPORT=<port> DB=<db> bash scripts/qa/spend-authorization-postgres.sh
set -uo pipefail
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
MIG=$R/supabase/proposals/20261024000000_spend_authorizations.sql; RB=$R/supabase/proposals/20261024000000_spend_authorizations.rollback.sql
DB=${DB:-atomivid}; Q="psql -U postgres -d $DB -v ON_ERROR_STOP=1 -qAt"
FAILS=0; ok(){ echo "PASS $*"; }; bad(){ echo "FAIL $*"; FAILS=$((FAILS+1)); }
eq(){ [ "$1" = "$2" ] && ok "$3" || bad "$3 (got '$1', want '$2')"; }
case "$DB" in *prod*|postgres) echo "refusing DB $DB"; exit 2;; esac

U1=aaaaaaaa-0000-4000-8000-0000000000a1; U2=bbbbbbbb-0000-4000-8000-0000000000b2
EP=2a000000-0000-4000-8000-0000000000e2; PJ=podcast-$EP; EP2=2a000000-0000-4000-8000-0000000000e3; PJ2=podcast-$EP2
JOB=e8048599-0000-4000-8000-000000000000; DPJ=documentary:$U1:walton
setup() {
$Q <<SQL
insert into auth.users(id,email) values ('$U1','hans@x'),('$U2','other@x') on conflict do nothing;
insert into public.podcast_episodes(id,user_id,title,source,script,voice_id,characters,estimated_usd) values
 ('$EP','$U1','Travis Walton Ep. 2','tts','x','voiceDavid01',16800,3.36),('$EP2','$U2','ajeno','tts','x','v2',100,0.02) on conflict do nothing;
-- Production-like ElevenLabs policy (pi_supply_policies in msyxczcdjhbednmfzxqq, read 2026-10-23) but max_concurrent 4
-- so the concurrency test measures the authorization lock, not the provider slot.
update public.pi_supply_policies set enabled=true, unit='character', unit_cost_usd=0.0002, baseline=63002, daily_forecast=1,
  daily_cap_usd=20, monthly_cap_usd=150, max_concurrent=4, max_daily_calls=14, timezone='America/Cancun', evidence='local test' where provider='elevenlabs';
update public.pi_supply_policies set daily_cap_usd=40, monthly_cap_usd=300 where provider='__global__';
insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at) values ('elevenlabs','character',100996,'OK','provider_api','GREEN',clock_timestamp());
SQL
}
op() { # key project usd status [committed] [reconciled]
$Q -c "insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,committed_usd,status,capacity_units,supply_reconciled)
 values ('$1','$2','voice:$1','elevenlabs','eleven_multilingual_v2','tts_with_timestamps','initial',$3,${5:-null},'$4',round($3/0.0002),${6:-false})"; }
submit() { $Q -c "select public.pi_submit_with_supply('$1', null)->>'reason'"; }
status() { $Q -c "select status from public.pi_paid_operations where idempotency_key='$1'"; }
fresh() { $Q -c "insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at) values ('elevenlabs','character',100996,'OK','provider_api','GREEN',clock_timestamp())"; }

echo "== T01 apply migration twice (re-runnable)"
$Q -f "$MIG" >/dev/null 2>&1 && $Q -f "$MIG" >/dev/null 2>&1 && ok "T01 migration applies and re-applies" || bad "T01 migration"
setup

echo "== T02 podcast paid call WITHOUT authorization"
op k_noauth $PJ 1.80 RESERVED; eq "$(submit k_noauth)" "authorization missing" "T02 refused: authorization missing"; eq "$(status k_noauth)" RESERVED "T02 row stays RESERVED (never SUBMITTED → provider never called)"

echo "== T03 open authorization: owner comes from the episode; checks"
eq "$($Q -c "select public.pi_open_spend_authorization('$EP',3.40,'hans-walton-ep2')->>'opened'")" true "T03 opened USD 3.40"
eq "$($Q -c "select owner_id from public.pi_spend_authorizations where project_id='$PJ'")" "$U1" "T03 owner_id = episode owner"
eq "$($Q -c "select cardinality(baseline_keys) from public.pi_spend_authorizations where project_id='$PJ'")" 1 "T03 baseline captured pre-existing op (not counted)"
eq "$($Q -c "select public.pi_open_spend_authorization('$EP',9,'again')->>'reason'")" already_open "T03 second open refused (immutable, one per episode)"
$Q -c "select public.pi_open_spend_authorization('$EP2',101,'x')" >/dev/null 2>&1 && bad "T03 cap>100 accepted" || ok "T03 CHECK rejects cap > 100"
$Q -c "select public.pi_open_spend_authorization('$EP2',1,' ')" >/dev/null 2>&1 && bad "T03 empty ref accepted" || ok "T03 empty authorization_ref rejected"
$Q -c "insert into public.pi_spend_authorizations(project_id,owner_id,cap_usd,authorization_ref) values ('documentary:x','$U1',1,'r')" >/dev/null 2>&1 && bad "T03 non-podcast row" || ok "T03 CHECK project_id like podcast-%"

echo "== T04 immutability"
$Q -c "update public.pi_spend_authorizations set cap_usd=50 where project_id='$PJ'" >/dev/null 2>&1 && bad "T04 cap raised" || ok "T04 cap cannot be raised"
$Q -c "delete from public.pi_spend_authorizations where project_id='$PJ'" >/dev/null 2>&1 && bad "T04 deleted" || ok "T04 cannot be deleted"
$Q -c "update public.pi_spend_authorizations set owner_id='$U2' where project_id='$PJ'" >/dev/null 2>&1 && bad "T04 owner changed" || ok "T04 owner cannot change"

echo "== T05 Walton Ep. 2: 2 chunks (1.80 + 1.56 = 3.36) fit 3.40; anything more is refused before the provider"
op c1 $PJ 1.80 RESERVED; eq "$(submit c1)" admitted "T05 chunk 1 admitted"; $Q -c "update public.pi_paid_operations set status='COMMITTED',committed_usd=1.80 where idempotency_key='c1'"
op c2 $PJ 1.56 RESERVED; eq "$(submit c2)" admitted "T05 chunk 2 admitted (pending counts)"
op c3 $PJ 0.05 RESERVED; eq "$(submit c3)" "authorization exceeded" "T05 extra call refused (1.80 committed + 1.56 pending + 0.05 > 3.40)"; eq "$(status c3)" RESERVED "T05 refused row never SUBMITTED"
eq "$($Q -c "select (public.pi_spend_authorization_usage('$PJ')->>'remainingUsd')::numeric")" 0.0400 "T05 remaining 0.04"

echo "== T06 every kind of charge counts: committed (actual), pending, uncertain, unreconciled refund, retry ordinal"
$Q -c "update public.pi_paid_operations set status='RECONCILIATION_REQUIRED' where idempotency_key='c2'"
eq "$(submit c3)" "authorization exceeded" "T06 RECONCILIATION_REQUIRED (uncertain) still counts"
$Q -c "update public.pi_paid_operations set status='REFUNDED', supply_reconciled=false where idempotency_key='c2'"
eq "$(submit c3)" "authorization exceeded" "T06 unreconciled REFUNDED still counts"
op c2ok $PJ 1.00 REFUNDED null true
eq "$($Q -c "select public.pi_spend_authorization_usage('$PJ')->>'pendingUsd'")" 1.5600 "T06 a reconciled refund (supply_reconciled) adds nothing; the unreconciled one keeps 1.56 pending"
op c2retry $PJ 1.56 RESERVED; eq "$(submit c2retry)" "authorization exceeded" "T06 retry of chunk 2 (new ordinal key) is a new charge and is counted: refused"
op c4 $PJ 0.03 COMMITTED 0.01
eq "$($Q -c "select public.pi_spend_authorization_usage('$PJ')->>'committedUsd'")" 1.8100 "T06 committed uses the ACTUAL committed_usd (provider cost), not the estimate"

echo "== T07 owner mismatch / closed"
$Q -c "insert into public.pi_spend_authorizations(project_id,owner_id,cap_usd,authorization_ref) values ('$PJ2','$U1',5,'wrong-owner')"
op x1 $PJ2 0.01 RESERVED; eq "$(submit x1)" "authorization owner mismatch" "T07 authorization of another owner refused"
$Q -c "update public.pi_spend_authorizations set status='CLOSED', closed_at=now() where project_id='$PJ2'"
eq "$(submit x1)" "authorization closed" "T07 closed authorization refused"
$Q -c "update public.pi_spend_authorizations set status='ACTIVE' where project_id='$PJ2'" >/dev/null 2>&1 && bad "T07 reopened" || ok "T07 closed cannot be reopened"

echo "== T08 concurrency: two sessions race for the last USD 1.00 (FOR UPDATE)"
EP3=2a000000-0000-4000-8000-0000000000e4; PJ3=podcast-$EP3
$Q -c "insert into public.podcast_episodes(id,user_id,title,source,script,voice_id) values ('$EP3','$U1','race','tts','x','v')"
$Q -c "select public.pi_open_spend_authorization('$EP3',1.00,'race')" >/dev/null; fresh
op rA $PJ3 0.90 RESERVED; op rB $PJ3 0.90 RESERVED
( $Q -c "begin; select public.pi_submit_with_supply('rA',null)->>'reason'; select pg_sleep(2); commit;" > /tmp/raceA.out 2>&1 ) &
sleep 0.5
T0=$(date +%s.%N); ( $Q -c "select public.pi_submit_with_supply('rB',null)->>'reason'" > /tmp/raceB.out 2>&1 ); T1=$(date +%s.%N); wait
echo "  session A: $(tr '\n' ' ' < /tmp/raceA.out)  session B: $(cat /tmp/raceB.out)  B waited $(python3 -c "print(round($T1-$T0,2))") s"
eq "$($Q -c "select count(*) from public.pi_paid_operations where project_id='$PJ3' and status='SUBMITTED'")" 1 "T08 exactly one admitted"
eq "$(cat /tmp/raceB.out)" "authorization exceeded" "T08 the loser is refused after waiting for the lock"
python3 -c "import sys; sys.exit(0 if $T1-$T0 > 1.0 else 1)" && ok "T08 B blocked on the row lock until A committed" || bad "T08 no lock wait observed"

echo "== T09 DB-only enforcement (no app): daily ElevenLabs quota still applies with an authorization"
EP4=2a000000-0000-4000-8000-0000000000e5; PJ4=podcast-$EP4
$Q -c "insert into public.podcast_episodes(id,user_id,title,source,script,voice_id) values ('$EP4','$U1','quota','tts','x','v')"
$Q -c "select public.pi_open_spend_authorization('$EP4',5,'quota')" >/dev/null; fresh
USED=$($Q -c "select (public.pi_supply_state('elevenlabs')->>'todayCalls')::int")
for i in $(seq $((USED+1)) 14); do op q$i $PJ4 0.001 COMMITTED 0.001; done
op q15 $PJ4 0.001 RESERVED; eq "$(submit q15)" "daily request quota" "T09 15th ElevenLabs call of the day refused by pi_submit_with_supply_core (max_daily_calls=14)"

echo "== T10 documentary: DB backstop on the PR #194 resume path"
$Q -c "insert into public.documentary_script_jobs(id,user_id,input_hash,topic,status,retry_count,failure_kind) values ('$JOB','$U1','h','Walton','failed',3,'technical')" >/dev/null 2>&1 || \
$Q -c "insert into public.documentary_script_jobs(id,user_id,input_hash,topic,status,retry_count) values ('$JOB','$U1','h','Walton','failed',3)"
$Q -c "update public.documentary_script_jobs set status='queued' where id='$JOB'" >/dev/null 2>&1 && bad "T10 exhausted job requeued without budget" || ok "T10 exhausted job (retry_count 3) cannot be requeued without a recovery budget — even by service role SQL"
$Q -c "select public.pi_open_recovery_budget('$JOB','$DPJ',0.60,'hans-2026-10-23-e8048599-150fb502')" >/dev/null
echo "== T10b audit P0-1: e8048599 production state = budget ACTIVE, cap 0.60, funded, 0 durable resume authorizations"
eq "$($Q -c "select status||' '||cap_usd::numeric(12,2) from public.pi_recovery_budgets where job_id='$JOB'")" "ACTIVE 0.60" "T10b budget ACTIVE and funded (cap 0.60)"
eq "$($Q -c "select count(*) from public.pi_recovery_resume_authorizations where project_id='$DPJ'")" 0 "T10b 0 rows in pi_recovery_resume_authorizations (as in production)"
eq "$(psql -U postgres -d $DB -qAt -c "set role service_role; select public.pi_recovery_resume_authorization('$DPJ','hans-2026-10-23-e8048599-150fb502')->>'authorized'")" false "T10b RPC (as service_role) reports no durable authorization => app refuses"
$Q -c "update public.documentary_script_jobs set status='queued' where id='$JOB'" >/dev/null 2>&1 && bad "T10b requeued without durable authorization" || ok "T10b requeue REFUSED in the DB: ACTIVE funded budget without durable authorization (0 updates)"
eq "$($Q -c "select status from public.documentary_script_jobs where id='$JOB'")" failed "T10b job still failed (0 updates)"
eq "$($Q -c "select count(*) from public.pi_paid_operations where project_id='$DPJ'")" 0 "T10b 0 paid operations for the job"
$Q -c "insert into public.pi_recovery_resume_authorizations(project_id,authorization_ref) values ('$DPJ','hans-resume-ok')" >/dev/null
eq "$(psql -U postgres -d $DB -qAt -c "set role service_role; select (r->>'authorized')||' '||((r->>'transactionId') is not null) from (select public.pi_recovery_resume_authorization('$DPJ','hans-resume-ok') r) x")" "true true" "T10b with a durable row (transaction_id set) the RPC authorizes"
eq "$(psql -U postgres -d $DB -qAt -c "set role service_role; select public.pi_recovery_resume_authorization('$DPJ','other-ref')->>'authorized'")" false "T10b a different authorization_ref does not match"
$Q -c "update public.documentary_script_jobs set status='queued' where id='$JOB'" >/dev/null 2>&1 && bad "T10c requeued with a durable row for ANOTHER ref (A/B bypass)" || ok "T10c durable row for ref B does NOT unlock the budget opened under ref A (0 updates)"
eq "$($Q -c "select status from public.documentary_script_jobs where id='$JOB'")" failed "T10c job still failed after the A/B attempt"
eq "$($Q -c "select count(*) from public.pi_paid_operations where project_id='$DPJ'")" 0 "T10c 0 paid operations after the A/B attempt"
$Q -c "insert into public.pi_recovery_resume_authorizations(project_id,authorization_ref) values ('$DPJ','hans-2026-10-23-e8048599-150fb502')" >/dev/null
$Q -c "update public.documentary_script_jobs set status='queued' where id='$JOB'" >/dev/null 2>&1 && ok "T10b requeue allowed with ACTIVE budget + durable authorization for the SAME ref" || bad "T10b requeue with durable authorization"
J2=e8048599-0000-4000-8000-000000000001
$Q -c "insert into public.documentary_script_jobs(id,user_id,input_hash,topic,status,retry_count) values ('$J2','$U1','h2','x','failed',1)"
$Q -c "update public.documentary_script_jobs set status='queued', retry_count=2 where id='$J2'" >/dev/null 2>&1 && ok "T10 normal «Reintentar» (retry_count<3) unchanged" || bad "T10 normal retry blocked"
$Q -c "insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status) values ('d1','$DPJ','s','anthropic','m','generate_script','initial',0.70,'RESERVED')"
eq "$(submit d1)" "recovery budget exceeded" "T10 documentary recovery budget caps per call in the DB (0.70 > 0.60)"
echo "  NOTE: first-run documentary calls (no recovery budget) are NOT capped per project in the DB — see report."

echo "== T11 rollback, then re-apply"
$Q -f "$RB" >/dev/null 2>&1 && $Q -f "$RB" >/dev/null 2>&1 && ok "T11 rollback applies and re-applies" || bad "T11 rollback"
eq "$($Q -c "select to_regprocedure('public.pi_submit_with_supply_pre_authz(text,numeric)') is null")" t "T11 original pi_submit_with_supply restored"
op rb1 podcast-ffffffff-0000-4000-8000-000000000000 0.01 RESERVED; fresh; R1=$(submit rb1); [ "$R1" != "authorization missing" ] && [ "$R1" != "authorization exceeded" ] && ok "T11 after rollback the authorization rule is gone (reason: $R1)" || bad "T11 rule still active"
$Q -f "$MIG" >/dev/null 2>&1 && ok "T11 re-apply after rollback" || bad "T11 re-apply"
op rb2 $PJ 1.00 RESERVED; eq "$(submit rb2)" "authorization exceeded" "T11 rule active again after re-apply (table kept, cap still enforced)"
op rb3 podcast-eeeeeeee-0000-4000-8000-000000000000 0.01 RESERVED; eq "$(submit rb3)" "authorization missing" "T11 missing authorization refused again after re-apply"

echo "== T12 privileges (audit P0-2): SECURITY DEFINER, search_path='', EXECUTE only service_role/postgres"
for f in "pi_submit_with_supply(text,numeric)" "pi_submit_with_supply_pre_authz(text,numeric)" "pi_open_spend_authorization(uuid,numeric,text)" "pi_spend_authorization_usage(text,text)" "pi_recovery_resume_authorization(text,text)"; do
  eq "$($Q -c "select prosecdef||' '||array_to_string(proconfig,',') from pg_proc where oid='public.$f'::regprocedure")" "true search_path=\"\"" "T12 $f SECURITY DEFINER + search_path=''"
  eq "$($Q -c "select string_agg(r||'='||has_function_privilege(r,'public.$f','EXECUTE'),' ' order by r) from unnest(array['anon','authenticated','postgres','service_role']) r")" "anon=false authenticated=false postgres=true service_role=true" "T12 $f EXECUTE"
  eq "$($Q -c "select count(*) from pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='public.$f'::regprocedure and a.grantee=0")" 0 "T12 $f no PUBLIC grant"
done
for f in "pi_spend_authorization_guard()" "pi_documentary_resume_requires_budget()"; do
  eq "$($Q -c "select array_to_string(proconfig,',')||' anon='||has_function_privilege('anon','public.$f','EXECUTE')||' authenticated='||has_function_privilege('authenticated','public.$f','EXECUTE')||' public='||(select count(*) from aclexplode(coalesce(proacl,acldefault('f',proowner))) a where a.grantee=0) from pg_proc where oid='public.$f'::regprocedure")" "search_path=\"\" anon=false authenticated=false public=0" "T12 trigger $f search_path='' and no client EXECUTE"
done
for r in anon authenticated; do
  out=$(psql -U postgres -d $DB -qAt -c "set role $r; select public.pi_submit_with_supply('x',null)" 2>&1); echo "$out" | grep -q "permission denied" && ok "T12 $r calling pi_submit_with_supply => permission denied" || bad "T12 $r executed ($out)"
  out=$(psql -U postgres -d $DB -qAt -c "set role $r; select public.pi_open_spend_authorization('$EP',1,'x')" 2>&1); echo "$out" | grep -q "permission denied" && ok "T12 $r calling pi_open_spend_authorization => permission denied" || bad "T12 $r executed open ($out)"
  out=$(psql -U postgres -d $DB -qAt -c "set role $r; select count(*) from public.pi_spend_authorizations" 2>&1); echo "$out" | grep -q "permission denied" && ok "T12 $r cannot read pi_spend_authorizations" || bad "T12 $r read table ($out)"
done
op sr1 podcast-dddddddd-0000-4000-8000-000000000000 0.01 RESERVED
eq "$(psql -U postgres -d $DB -qAt -c "set role service_role; select public.pi_submit_with_supply('sr1',null)->>'reason'")" "authorization missing" "T12 service_role executes pi_submit_with_supply (server path works, rule applies)"
EP9=2a000000-0000-4000-8000-0000000000f9
$Q -c "insert into public.podcast_episodes(id,user_id,title,source,script,voice_id,characters,estimated_usd) values ('$EP9','$U1','priv','tts','x','v',10,0.01)"
eq "$(psql -U postgres -d $DB -qAt -c "set role service_role; select public.pi_open_spend_authorization('$EP9',0.5,'hans-sr')->>'opened'")" true "T12 service_role executes pi_open_spend_authorization"

echo "RESULT $([ $FAILS = 0 ] && echo ALL PASS || echo "$FAILS FAIL")"
exit $FAILS
