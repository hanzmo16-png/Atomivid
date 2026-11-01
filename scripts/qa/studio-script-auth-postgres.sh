#!/usr/bin/env bash
# USD 0. Disposable proof of supabase/proposals/20261101152000_studio_script_spend_authorization.sql.
# Builds a STUB predecessor of pi_submit_with_supply (not the production body) so the studio-script
# gate can be reviewed without applying repo migrations and without any provider.
# Refuse every database name except the one studio-script-auth-db.sh creates. Never production.
# Usage: PGHOST=<socket dir> PGPORT=<port> DB=studio_script_auth bash scripts/qa/studio-script-auth-postgres.sh
set -uo pipefail
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
MIG=$R/supabase/proposals/20261101152000_studio_script_spend_authorization.sql
RB=$R/supabase/proposals/20261101152000_studio_script_spend_authorization.rollback.sql
DB=${DB:-studio_script_auth}
case "$DB" in studio_script_auth) ;; *) echo "refusing DB $DB"; exit 2;; esac
case "${PGHOST:-}" in /*) ;; *) echo "refusing non-local PGHOST"; exit 2;; esac
Q="psql -h $PGHOST -p $PGPORT -U postgres -d $DB -v ON_ERROR_STOP=1 -qAt"
FAILS=0; ok(){ echo "PASS $*"; }; bad(){ echo "FAIL $*"; FAILS=$((FAILS+1)); }
eq(){ [ "$1" = "$2" ] && ok "$3" || bad "$3 (got '$1', want '$2')"; }
U1=aaaaaaaa-0000-4000-8000-0000000000a1
U2=bbbbbbbb-0000-4000-8000-0000000000b2
JOB=11111111-2222-4333-8444-555555555555
JOB2=22222222-3333-4444-8555-666666666666
EP=cccccccc-dddd-4eee-8fff-0000000000c1
EP2=dddddddd-eeee-4fff-8000-0000000000d2
PID="studio-script:$U1:$JOB"

$Q <<'SQL' >/dev/null
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key, email text);
grant usage on schema auth, public to anon, authenticated, service_role;
create table if not exists public.pi_paid_operations (
  idempotency_key text primary key,
  project_id text not null,
  status text not null,
  reserved_usd numeric,
  committed_usd numeric,
  method text not null default 'generate_script',
  supply_reconciled boolean not null default false
);
create table if not exists public.podcast_studio_episodes (
  id uuid primary key,
  user_id uuid not null,
  status text not null
);
SQL

# Replace only on this disposable database. The name check above is the guard.
$Q <<'SQL' >/dev/null
create or replace function public.pi_submit_with_supply(p_key text, p_units numeric default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.pi_paid_operations%rowtype;
begin
  select * into o from public.pi_paid_operations where idempotency_key = p_key for update;
  if not found then return jsonb_build_object('submitted', false, 'reason', 'not_found'); end if;
  if o.status <> 'RESERVED' then return jsonb_build_object('submitted', false, 'reason', 'already_claimed'); end if;
  update public.pi_paid_operations set status = 'SUBMITTED' where idempotency_key = p_key;
  return jsonb_build_object('submitted', true, 'reason', 'admitted');
end $$;
revoke all on function public.pi_submit_with_supply(text, numeric) from public, anon, authenticated;
grant execute on function public.pi_submit_with_supply(text, numeric) to service_role;
SQL

echo "== S01 apply twice"
$Q -f "$MIG" >/dev/null && $Q -f "$MIG" >/dev/null && ok "S01 proposal applies twice" || bad "S01 apply"
$Q -c "insert into auth.users(id, email) values ('$U1','hans@x'),('$U2','other@x') on conflict do nothing" >/dev/null

as_svc() { $Q -c "set role service_role; select $1"; }
reason() { as_svc "public.pi_submit_with_supply('$1', null)->>'reason'"; }
status() { $Q -c "select status from public.pi_paid_operations where idempotency_key='$1'"; }
op() { $Q -c "insert into public.pi_paid_operations(idempotency_key, project_id, status, reserved_usd, committed_usd, method, supply_reconciled) values ('$1','$2','${4:-RESERVED}',$3,${5:-null},'${6:-generate_script}',${7:-false})"; }

echo "== S02 studio-script without a row is refused and stays RESERVED"
op k-none "$PID" 0.10
eq "$(reason k-none)" "authorization missing" "S02 authorization missing"
eq "$(status k-none)" "RESERVED" "S02 never SUBMITTED"

echo "== S03 open: owner from auth.users, transaction_id from the database, second open is the same triple"
OPEN=$(as_svc "public.pi_open_studio_script_authorization('$U1','$JOB',3,'studio-script-auth:$JOB',24)")
eq "$(echo "$OPEN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["opened"])')" "True" "S03 opened"
TX=$(echo "$OPEN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["transactionId"])')
REF=$(echo "$OPEN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["authorizationRef"])')
eq "$($Q -c "select owner_id::text||' '||transaction_id::text||' '||authorization_ref||' '||cardinality(baseline_keys) from public.pi_studio_script_authorizations where project_id='$PID'")" "$U1 $TX $REF 0" "S03 stored triple, empty baseline"
eq "$(as_svc "public.pi_open_studio_script_authorization('$U1','$JOB',9,'other',24)->>'reason'")" "already_open" "S03 second open refused"
eq "$(as_svc "public.pi_open_studio_script_authorization('$U1','$JOB',9,'other',24)->>'transactionId'")" "$TX" "S03 transaction_id unchanged"
eq "$(as_svc "public.pi_open_studio_script_authorization('$U2','$JOB',1,'x',24)->>'reason'")" "job owned by someone else" "S03 other owner cannot take the job"
eq "$(as_svc "public.pi_open_studio_script_authorization('$U1','$JOB2',51,'x',24)->>'reason'")" "cap out of range" "S03 cap > 50 refused"
eq "$(as_svc "public.pi_open_studio_script_authorization('$U1','$JOB2',1,' ',24)->>'reason'")" "authorization_ref required" "S03 blank ref refused"
eq "$(as_svc "public.pi_open_studio_script_authorization('cccccccc-dddd-4eee-8fff-0000000000c9','$JOB2',1,'x',24)->>'reason'")" "owner not found" "S03 unknown user refused"

echo "== S04 direct writes cannot forge the triple"
$Q -c "insert into public.pi_studio_script_authorizations(project_id,owner_id,job_id,cap_usd,authorization_ref,transaction_id,expires_at) values ('studio-script:$U2:$JOB2','$U2','$JOB2',1,'r',1,clock_timestamp()+interval '1 hour')" >/dev/null 2>&1 && bad "S04 superuser insert without GUC" || ok "S04 insert without GUC rejected"
FORGED=$($Q -c "begin; select set_config('atomivid.studio_script_open','1',true); insert into public.pi_studio_script_authorizations(project_id,owner_id,job_id,cap_usd,authorization_ref,transaction_id,expires_at) values ('studio-script:$U2:$JOB2','$U2','$JOB2',1,'forged',1,clock_timestamp()+interval '1 hour'); select case when transaction_id = txid_current() and transaction_id <> 1 then 'overwritten' else 'stuck' end from public.pi_studio_script_authorizations where job_id='$JOB2'; rollback;" | awk 'NF{line=$0} END{print line}')
eq "$FORGED" "overwritten" "S04 trigger overwrites a caller transaction_id"
as_svc "insert into public.pi_studio_script_authorizations(project_id,owner_id,job_id,cap_usd,authorization_ref,transaction_id,expires_at) values ('studio-script:$U2:$JOB2','$U2','$JOB2',1,'r',1,now())" >/dev/null 2>&1 && bad "S04 service_role insert" || ok "S04 service_role cannot insert"
$Q -c "update public.pi_studio_script_authorizations set cap_usd=50 where project_id='$PID'" >/dev/null 2>&1 && bad "S04 cap raised" || ok "S04 cap immutable"
$Q -c "delete from public.pi_studio_script_authorizations where project_id='$PID'" >/dev/null 2>&1 && bad "S04 deleted" || ok "S04 cannot delete"

echo "== S05 submit copies the triple onto the grant; the app only passed the key"
op k1 "$PID" 0.10
eq "$(reason k1)" "admitted" "S05 admitted"
eq "$(status k1)" "SUBMITTED" "S05 SUBMITTED"
eq "$($Q -c "select project_id||' '||authorization_ref||' '||transaction_id::text from public.pi_studio_script_spend_grants where idempotency_key='k1'")" "$PID $REF $TX" "S05 grant triple matches the open row"
eq "$(reason k1)" "already_claimed" "S05 second submit does not admit again"

echo "== S06 historical COMMITTED counts (baseline stays empty) and an unreconciled refund counts"
$Q -c "update public.pi_paid_operations set status='COMMITTED', committed_usd=0.10 where idempotency_key='k1'" >/dev/null
op k2 "$PID" 2.95
eq "$(reason k2)" "authorization exceeded" "S06 0.10 committed + 2.95 > 3"
eq "$(status k2)" "RESERVED" "S06 exceeded row stays RESERVED"
$Q -c "update public.pi_paid_operations set status='REFUNDED', supply_reconciled=false, reserved_usd=2.95 where idempotency_key='k2'" >/dev/null
op k3 "$PID" 0.10
eq "$(reason k3)" "authorization exceeded" "S06 unreconciled refund still counts"
$Q -c "update public.pi_paid_operations set supply_reconciled=true where idempotency_key='k2'" >/dev/null
eq "$(reason k3)" "admitted" "S06 reconciled refund frees the cap"

echo "== S07 malformed prefix fail-closed; a non studio project is delegated"
op bad "studio-script:NOT-A-UUID" 0.01
eq "$(reason bad)" "authorization owner mismatch" "S07 malformed studio-script refused"
op pod "podcast-$EP" 0.01
eq "$(reason pod)" "admitted" "S07 podcast- project is not captured by the studio gate"
eq "$($Q -c "select count(*) from public.pi_studio_script_spend_grants where idempotency_key='pod'")" "0" "S07 no grant for a delegated project"

echo "== S08 close, expire, bind"
eq "$(as_svc "public.pi_close_studio_script_authorization('$U2','$JOB')->>'reason'")" "authorization missing" "S08 another owner addresses a different project id"
# close a fresh job, not the one we still use for bind
as_svc "public.pi_open_studio_script_authorization('$U1','$JOB2',1,'studio-script-auth:$JOB2',24)" >/dev/null
eq "$(as_svc "public.pi_close_studio_script_authorization('$U1','$JOB2')->>'closed'")" "true" "S08 closed"
op cjob "studio-script:$U1:$JOB2" 0.01
eq "$(reason cjob)" "authorization closed" "S08 closed job refuses submit"

$Q -c "insert into public.podcast_studio_episodes(id,user_id,status) values ('$EP','$U2','draft'),('$EP2','$U1','draft')" >/dev/null
eq "$(as_svc "public.pi_bind_studio_script_authorization('$U1','$JOB','$EP')->>'reason'")" "authorization owner mismatch" "S08 episode of another owner refused"
eq "$(as_svc "public.pi_bind_studio_script_authorization('$U1','$JOB','$EP2')->>'bound'")" "true" "S08 bound"
eq "$($Q -c "select status||' '||episode_id::text from public.pi_studio_script_authorizations where project_id='$PID'")" "BOUND $EP2" "S08 status BOUND"
eq "$($Q -c "select authorization_ref||' '||transaction_id::text from public.pi_studio_script_episode_bindings where episode_id='$EP2'")" "$REF $TX" "S08 binding stores the same triple"
op after "$PID" 0.01
eq "$(reason after)" "authorization closed" "S08 BOUND refuses further script submits"
eq "$(as_svc "public.pi_bind_studio_script_authorization('$U1','$JOB','$EP2')->>'state'")" "already_bound" "S08 rebind is idempotent"
eq "$(as_svc "public.pi_bind_studio_script_authorization('$U1','$JOB','$EP')->>'reason'")" "job already bound" "S08 cannot retarget after bind"
as_svc "delete from public.pi_studio_script_episode_bindings where episode_id='$EP2'" >/dev/null 2>&1 && bad "S08 service_role deleted a binding" || ok "S08 service_role cannot delete a binding"

echo "== S09 expiry is lazy on submit"
JOB3=33333333-4444-4555-8666-777777777777
as_svc "public.pi_open_studio_script_authorization('$U1','$JOB3',1,'studio-script-auth:$JOB3',1.0/3600)" >/dev/null
sleep 2
op late "studio-script:$U1:$JOB3" 0.01
eq "$(reason late)" "authorization expired" "S09 expired"
eq "$($Q -c "select status from public.pi_studio_script_authorizations where job_id='$JOB3'")" "EXPIRED" "S09 status EXPIRED"
eq "$(status late)" "RESERVED" "S09 expired call never submitted"

echo "== S10 uncertain spend blocks a new open"
JOB4=44444444-5555-4666-8777-888888888888
op unc "studio-script:$U1:$JOB4" 0.01 SUBMITTED
eq "$(as_svc "public.pi_open_studio_script_authorization('$U1','$JOB4',1,'studio-script-auth:$JOB4',24)->>'reason'")" "uncertain operations must be reconciled first" "S10 uncertain blocks open"

echo "== S11 rollback restores the predecessor; re-apply restores the gate"
$Q -f "$RB" >/dev/null && ok "S11 rollback" || bad "S11 rollback"
op back "studio-script:$U2:55555555-6666-4777-8888-999999999999" 0.01
eq "$(reason back)" "admitted" "S11 after rollback the studio gate is gone"
$Q -f "$MIG" >/dev/null && ok "S11 re-apply" || bad "S11 re-apply"
op back2 "studio-script:$U2:55555555-6666-4777-8888-999999999999" 0.02
eq "$(reason back2)" "authorization missing" "S11 gate is back"

echo "== S12 privileges"
for f in "pi_submit_with_supply(text,numeric)" "pi_open_studio_script_authorization(uuid,uuid,numeric,text,numeric)" "pi_studio_script_authorization_usage(text,text)" "pi_bind_studio_script_authorization(uuid,uuid,uuid)" "pi_close_studio_script_authorization(uuid,uuid)" "pi_expire_studio_script_authorizations()"; do
  eq "$($Q -c "select prosecdef||' '||array_to_string(proconfig,',') from pg_proc where oid='public.$f'::regprocedure")" "true search_path=\"\"" "S12 $f definer + search_path"
  eq "$($Q -c "select string_agg(r||'='||has_function_privilege(r,'public.$f','EXECUTE'),' ' order by r) from unnest(array['anon','authenticated','service_role']) r")" "anon=false authenticated=false service_role=true" "S12 $f execute"
done
eq "$($Q -c "select has_function_privilege('service_role','public.pi_submit_with_supply_pre_studio_script(text,numeric)','EXECUTE')")" "f" "S12 service_role cannot call the predecessor"
eq "$($Q -c "select has_table_privilege('service_role','public.pi_studio_script_authorizations','INSERT')")" "f" "S12 service_role cannot insert authorizations"
eq "$($Q -c "select has_table_privilege('service_role','public.pi_studio_script_spend_grants','INSERT')")" "f" "S12 service_role cannot insert grants"

echo
if [ "$FAILS" = 0 ]; then echo "ALL PASS"; exit 0; fi
echo "FAILURES $FAILS"; exit 1
