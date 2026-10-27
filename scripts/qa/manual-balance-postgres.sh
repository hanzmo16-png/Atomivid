#!/usr/bin/env bash
# USD 0. Real disposable PostgreSQL: a MANUAL fal.ai (Recraft) balance, as ops-recraft-enable registers it, is reduced by
# every later consumption, in-flight call, unreconciled refund and open job reservation; earlier consumption is not
# subtracted twice; provider caps and the per-key idempotency still apply. Never production.
# Usage: bash scripts/qa/spend-authorization-db.sh <workdir> <port> scripts/qa/manual-balance-postgres.sh
set -uo pipefail
DB=${DB:-atomivid}; Q="psql -U postgres -d $DB -v ON_ERROR_STOP=1 -qAt"
FAILS=0; ok(){ echo "PASS $*"; }; bad(){ echo "FAIL $*"; FAILS=$((FAILS+1)); }
eq(){ [ "$1" = "$2" ] && ok "$3" || bad "$3 (got '$1', want '$2')"; }
case "$DB" in *prod*|postgres) echo "refusing DB $DB"; exit 2;; esac
PJ=video:e8048599-recraft
op() { # key usd status [committed] [updated_offset] [reconciled]
$Q -c "insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,committed_usd,status,capacity_units,supply_reconciled,created_at,updated_at)
 values ('$1','$PJ','img:$1','recraft','fal-ai/recraft/v3/text-to-image','image','initial',$2,${4:-null},'$3',$2,${6:-false},clock_timestamp()-interval '${5:-0 minutes}',clock_timestamp()-interval '${5:-0 minutes}')"; }
free() { $Q -c "select round((public.pi_supply_state('recraft')->>'free')::numeric,4)"; }

# Production Recraft policy shape (ops read 2026-10-24: unit usd, caps 10/day 50/month, 1 concurrent, 250 calls) once enabled.
$Q -c "insert into public.pi_supply_policies(provider,enabled,unit) values ('recraft',false,'usd') on conflict (provider) do nothing"
$Q -c "update public.pi_supply_policies set enabled=true, unit='usd', unit_cost_usd=1, baseline=10, daily_forecast=0.5, daily_cap_usd=10, monthly_cap_usd=50, max_concurrent=1, max_daily_calls=250, timezone='America/Cancun', evidence='test' where provider='recraft'"

echo "== M01 no balance registered => UNKNOWN (production today: lastSnapshot null)"
eq "$($Q -c "select public.pi_supply_state('recraft')->>'level'")" UNKNOWN "M01 no snapshot => UNKNOWN, Recraft cannot start"

echo "== M02 owner reads USD 6.00 in the fal.ai dashboard 2 h ago; registered now with checked_at = time of reading"
op before 0.04 COMMITTED 0.04 "3 hours"            # billed BEFORE the reading: already inside the 6.00
$Q -c "insert into public.pi_capacity_snapshots(provider,unit,available,reserved,pending,health,reliability,status,checked_at) values ('recraft','usd',6.00,0,0,'OK','manual_entry','GREEN',clock_timestamp()-interval '2 hours')"
eq "$($Q -c "select reliability||' '||(checked_at < clock_timestamp()-interval '1 hour') from public.pi_capacity_snapshots where provider='recraft' order by checked_at desc limit 1")" "manual_entry true" "M02 snapshot keeps provenance (manual_entry) and the reading time"
eq "$(free)" 6.0000 "M02 consumption before the reading is not subtracted again"

echo "== M03 later consumption, in-flight call, unreconciled refund and open job reservation reduce availability"
op after1 0.04 COMMITTED 0.04 "1 hour"; op after2 0.08 COMMITTED 0.08 "30 minutes"
eq "$(free)" 5.8800 "M03 two images billed after the reading (0.12) subtracted"
op inflight 0.04 SUBMITTED; eq "$(free)" 5.8400 "M03 in-flight (SUBMITTED) image subtracted before it is billed"
op refunded 0.04 REFUNDED 0 "10 minutes" false; eq "$(free)" 5.8000 "M03 refund not reconciled with the provider still subtracted"
$Q -c "insert into public.pi_supply_job_reservations(id,project_id,render_attempt,provider,reserved_units,reserved_usd) values ('job-a','$PJ',1,'recraft',2.00,2.00)"
eq "$(free)" 3.8000 "M03 concurrent job reservation (USD 2.00 open) subtracted"
$Q -c "update public.pi_supply_job_reservations set consumed_units=0.50, consumed_usd=0.50 where id='job-a'"
eq "$(free)" 4.3000 "M03 only the unconsumed part of a reservation is held"

echo "== M04 idempotency: the same key cannot be reserved twice (no duplicate charge row)"
$Q -c "insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status) values ('after1','$PJ','img:x','recraft','m','image','retry',0.04,'RESERVED')" >/dev/null 2>&1 && bad "M04 duplicate key accepted" || ok "M04 duplicate idempotency key rejected by the ledger"

echo "== M05 provider cap: the in-flight call holds the single concurrency slot; the next image waits"
op next 0.04 RESERVED
r=$($Q -c "select public.pi_submit_with_supply('next', null)->>'reason'"); case "$r" in *concurren*|*active*|*slot*) ok "M05 second concurrent Recraft call refused ($r)";; *) bad "M05 concurrency (got '$r')";; esac
$Q -c "update public.pi_paid_operations set status='COMMITTED', committed_usd=0.04, updated_at=clock_timestamp() where idempotency_key='inflight'"
r=$($Q -c "select coalesce(public.pi_submit_with_supply('next', null)->>'reason','')||' '||coalesce(public.pi_supply_state('recraft')->>'level','')"); case "$r" in *GREEN*|*YELLOW*) ok "M05 after the slot frees, the next call is evaluated against the reduced balance ($r)";; *) bad "M05 after slot (got '$r')";; esac

echo "== M06 balance exhausted => RED: no new Recraft call"
$Q -c "insert into public.pi_supply_job_reservations(id,project_id,render_attempt,provider,reserved_units,reserved_usd) values ('job-b','$PJ',2,'recraft',4.20,4.20)"
eq "$($Q -c "select public.pi_supply_state('recraft')->>'level'")" RED "M06 reservations consuming the remaining balance turn the state RED"
[ $FAILS = 0 ] && echo "RESULT ALL PASS" || { echo "RESULT $FAILS FAIL"; exit 1; }
