#!/bin/bash
# Two REAL concurrent sessions against a migrated local Postgres (no provider calls).
# usage: documentary_recovery_budget_concurrency.sh "<psql connection args>" <db>
set -euo pipefail
PSQL="psql $1 -d $2 -v ON_ERROR_STOP=1 -qtA"
$PSQL <<'SQL'
insert into auth.users(id,email) values ('33333333-3333-4333-8333-333333333333','conc@fixture.invalid') on conflict do nothing;
insert into public.pi_provider_accounts(provider,production_account_label,plan,secret_reference_name,status,balance_source)
values ('conc-fixture','concurrency simulation','fixture','SUPPLY_TEST_KEY','unknown','none') on conflict do nothing;
insert into public.pi_supply_policies(provider,enabled,unit,baseline,unit_cost_usd,daily_forecast,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls,evidence)
values ('conc-fixture',true,'usd',1000,1,0,1000,1000,50,1000,'fixture evidence') on conflict do nothing;
update public.pi_supply_policies set enabled=true,daily_cap_usd=100000,monthly_cap_usd=100000,evidence='fixture ceiling' where provider='__global__';
insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at) values('conc-fixture','usd',1000,'OK','provider_api','GREEN',clock_timestamp());
insert into public.documentary_script_jobs(id,user_id,input_hash,topic,status,stage)
values ('03738404-0000-4000-8000-0000000000c1','33333333-3333-4333-8333-333333333333','hc','Fixture concurrency','failed','x');
-- The budget is opened FIRST (its baseline is whatever already exists); c1/c2 are new work.
select public.pi_open_recovery_budget('03738404-0000-4000-8000-0000000000c1','documentary:33333333-3333-4333-8333-333333333333:conc',1.00,'fixture')->>'opened';
insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status)
values ('c1','documentary:33333333-3333-4333-8333-333333333333:conc','s1','conc-fixture','fixture','generate_script','initial',0.6,'RESERVED'),
       ('c2','documentary:33333333-3333-4333-8333-333333333333:conc','s2','conc-fixture','fixture','generate_script','initial',0.6,'RESERVED');
SQL
# Session A admits c1 and keeps its transaction open for 2 s; session B tries c2 meanwhile.
( $PSQL -c "begin; select 'A ' || public.pi_submit_with_supply('c1',0.6)::text; select pg_sleep(2); commit;" ) > /tmp/conc_a.out &
sleep 0.5
start=$(date +%s.%N)
B=$($PSQL -c "select public.pi_submit_with_supply('c2',0.6)->>'reason'")
waited=$(echo "$(date +%s.%N) - $start" | bc)
wait
echo "A: $(grep -o '"reason": "[a-z ]*"' /tmp/conc_a.out)"
echo "B: reason=$B waited=${waited}s"
S=$($PSQL -c "select string_agg(idempotency_key||'='||status, ',' order by idempotency_key) from public.pi_paid_operations where idempotency_key in ('c1','c2')")
echo "ledger: $S"
[ "$B" = "recovery budget exceeded" ] && [ "$S" = "c1=SUBMITTED,c2=RESERVED" ] && awk "BEGIN{exit !($waited >= 1.0)}" \
  && echo "PASS: concurrent 0.60 + 0.60 under a 1.00 cap -> B waited for A's lock and was refused; one admission" || { echo "FAIL"; exit 1; }
