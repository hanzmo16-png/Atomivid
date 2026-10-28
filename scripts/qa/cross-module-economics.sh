#!/usr/bin/env bash
# USD 0. Cross-module economic checks (Reels, Podcast 2.x, Podcast Studio V3, Long Form, Avatar, Documentary) on a
# DISPOSABLE PostgreSQL built from the repo migrations, in the state AFTER the pending proposals (000000 spend
# authorizations, 120000, 130000, 140000 studio) — i.e. production after O8. Synthetic rows only; no provider is called.
# Every module goes through the real SQL admission chain: pi_submit_with_supply (podcast authorization → reel cap →
# documentary recovery budget → core: global lock, per-provider and global ceilings, concurrency, daily calls) and, for
# the studio, its own ledger + the BEFORE trigger podcast_studio_operations_cap that consults the same platform limits.
# Usage: bash scripts/qa/spend-authorization-db.sh <workdir> <port> "$PWD/scripts/qa/cross-module-economics.sh"
set -uo pipefail
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
DB=${DB:-atomivid}; Q="psql -U postgres -d $DB -v ON_ERROR_STOP=1 -qAt"
case "$DB" in *prod*|postgres) echo "refusing DB $DB"; exit 2;; esac
FAILS=0; ok(){ echo "PASS $*"; }; bad(){ echo "FAIL $*"; FAILS=$((FAILS+1)); }
eq(){ [ "$1" = "$2" ] && ok "$3" || bad "$3 (got '$1', want '$2')"; }
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

for p in 20261024000000_spend_authorizations 20261024120000_resume_authorization_ref_match 20261024130000_spend_authorization_baseline_fix 20261024140000_podcast_v3_studio; do
  $Q -f "$R/supabase/proposals/$p.sql" > "$W/$p.log" 2>&1 || { echo "FAIL proposal $p does not apply: $(grep -m1 ERROR "$W/$p.log")"; exit 1; }
  echo "INFO applied proposal $p ($(sha256sum "$R/supabase/proposals/$p.sql" | cut -c1-12))"
done

U1=c0000000-0000-4000-8000-0000000000a1; U2=c0000000-0000-4000-8000-0000000000a2
EP=c1000000-0000-4000-8000-000000000001; PJ=podcast-$EP; EP2=c1000000-0000-4000-8000-000000000002; PJ2=podcast-$EP2
REEL=c2000000-0000-4000-8000-000000000001; REEL2=c2000000-0000-4000-8000-000000000002
AV=c3000000-0000-4000-8000-000000000001; LF=c4000000-0000-4000-8000-000000000001
SE=c5000000-0000-4000-8000-000000000001
$Q <<SQL
insert into auth.users(id,email) values ('$U1','owner@x'),('$U2','other@x') on conflict do nothing;
insert into public.podcast_episodes(id,user_id,title,source,script,voice_id) values ('$EP','$U1','ep','tts','x','v'),('$EP2','$U1','ep2','tts','x','v');
insert into public.video_requests(id,user_id,topic,style,duration_seconds,mode,status,provider_spend_cap_usd) values
 ('$REEL','$U1','reel','s',30,'visual','processing',1.00),('$REEL2','$U1','reel2','s',30,'visual','processing',1.00),
 ('$AV','$U1','avatar','s',30,'avatar','processing',null),('$LF','$U1','long','s',60,'visual','processing',null);
insert into public.podcast_studio_episodes(id,user_id,title,mode,spec,status,authorized_usd) values
 ('$SE','$U1','studio','avatar','{"version":"podcast-studio/3"}','authorized',3.00);
-- Synthetic supply policies (USD units for every provider so amounts are easy to read). Deliberately small ceilings.
insert into public.pi_supply_policies(provider,enabled,unit,baseline,unit_cost_usd,daily_forecast,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls,free_daily_cap_usd,timezone,evidence)
values ('__global__',true,'usd',1000,1,1,100,500,100,1000,0,'UTC','cross-module synthetic'),
       ('openai',true,'usd',1000,1,1,100,500,100,1000,0,'UTC','cross-module synthetic'),
       ('elevenlabs',true,'usd',1000,1,1,100,500,100,1000,0,'UTC','cross-module synthetic'),
       ('heygen',true,'usd',1000,1,1,100,500,1,1000,0,'UTC','cross-module synthetic')
on conflict (provider) do update set enabled=excluded.enabled, unit=excluded.unit, baseline=excluded.baseline, unit_cost_usd=excluded.unit_cost_usd,
 daily_forecast=excluded.daily_forecast, daily_cap_usd=excluded.daily_cap_usd, monthly_cap_usd=excluded.monthly_cap_usd, max_concurrent=excluded.max_concurrent,
 max_daily_calls=excluded.max_daily_calls, free_daily_cap_usd=excluded.free_daily_cap_usd, timezone=excluded.timezone, evidence=excluded.evidence;
SQL
fresh() { $Q -c "insert into public.pi_capacity_snapshots(provider,unit,available,reserved,pending,health,reliability,status,checked_at) select p,'usd',1000,0,0,'OK','manual_entry','GREEN',clock_timestamp() from unnest(array['openai','elevenlabs','heygen']) p" >/dev/null; }
fresh
op() { # key project provider usd status [committed] [reconciled]
  $Q -c "insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,committed_usd,status,supply_reconciled)
   values ('$1','$2','s:$1','$3','m','x','initial',$4,${6:-null},'$5',${7:-false})"; }
submit() { $Q -c "select public.pi_submit_with_supply('$1', null)->>'reason'"; }
status() { $Q -c "select status from public.pi_paid_operations where idempotency_key='$1'"; }
studio() { # key provider usd [episode] — returns ok or the trigger's STUDIO_CAP reason
  $Q -c "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (encode(sha256('$1'::bytea),'hex'),'$U1','${4:-$SE}','$2','x','reserved',$3)" > "$W/s.out" 2>&1 \
    && echo ok || grep -oE 'STUDIO_CAP: [a-z]+( [a-z]+)*|duplicate key' "$W/s.out" | head -1; }
studio_set() { $Q -c "update public.podcast_studio_operations set state='$2', actual_usd=${3:-null} where key=encode(sha256('$1'::bytea),'hex')"; }
spend() { $Q -c "select public.pi_supply_spend(${1:-null}, date_trunc('day', clock_timestamp()))"; }
global_cap() { $Q -c "update public.pi_supply_policies set daily_cap_usd=$1 where provider='__global__'"; }
$Q -c "select public.pi_open_spend_authorization('$EP', 2.00, 'cross-module-synthetic')" >/dev/null

echo "== X1 per-request/per-episode budgets are isolated across modules on the SAME provider"
op x1p $PJ openai 0.80 RESERVED; eq "$(submit x1p)" admitted "X1 podcast image 0.80 admitted under its authorization (cap 2.00)"
$Q -c "update public.pi_paid_operations set status='COMMITTED', committed_usd=0.80 where idempotency_key='x1p'"
op x1r $REEL openai 0.90 RESERVED; eq "$(submit x1r)" admitted "X1 reel image 0.90 admitted: podcast spend on openai does not consume the reel cap (1.00)"
op x1r2 $REEL openai 0.20 RESERVED; eq "$(submit x1r2)" "reel budget exceeded" "X1 reel's own cap still binds (0.90 pending + 0.20 > 1.00)"
eq "$($Q -c "select public.pi_spend_authorization_usage('$PJ')->>'committedUsd'")" 0.8000 "X1 reel spend is not counted in the podcast authorization"
op x1l $LF openai 0.50 RESERVED; eq "$(submit x1l)" admitted "X1 long form (no per-request DB cap) admitted; reel cap of another request untouched"

echo "== X2 an authorization funds only its own episode"
op x2 $PJ2 openai 0.10 RESERVED; eq "$(submit x2)" "authorization missing" "X2 another podcast of the same owner without authorization is refused"
eq "$(status x2)" RESERVED "X2 refused row never SUBMITTED"

echo "== X3 an uncertain operation blocks only its own project+provider"
op x3u $PJ elevenlabs 0.10 RECONCILIATION_REQUIRED
op x3p $PJ elevenlabs 0.10 RESERVED; eq "$(submit x3p)" "previous consumption requires reconciliation" "X3 podcast blocked by its own uncertain elevenlabs call"
op x3r $REEL2 elevenlabs 0.10 RESERVED; eq "$(submit x3r)" admitted "X3 a reel on the same provider is not blocked by the podcast's uncertain call"

echo "== X4 the global daily ceiling is shared by BOTH ledgers (platform ops + podcast studio)"
fresh; S0=$(spend); global_cap "$(python3 -c "print(round($S0+1.00,4))")"
eq "$(studio x4s1 elevenlabs 0.60)" ok "X4 studio reservation 0.60 admitted (headroom 1.00)"
eq "$(spend)" "$(python3 -c "print(f'{$S0+0.60:.4f}')")" "X4 pi_supply_spend now includes the studio reservation"
op x4a $AV heygen 0.50 RESERVED; eq "$(submit x4a)" "global funded spend ceiling" "X4 avatar 0.50 refused: studio 0.60 + 0.50 > remaining 1.00"
eq "$(studio x4s2 openai 0.50)" "STUDIO_CAP: global funded spend ceiling" "X4 a second studio reservation 0.50 refused by the same global ceiling"
op x4b $AV heygen 0.30 RESERVED; eq "$(submit x4b)" admitted "X4 avatar 0.30 fits (0.60 + 0.30 <= 1.00)"
$Q -c "update public.pi_paid_operations set status='COMMITTED', committed_usd=0.30 where idempotency_key='x4b'"
global_cap 100

echo "== X5 provider concurrency is shared across ledgers (heygen max_concurrent = 1)"
fresh; studio_set x4s1 settled 0.60
eq "$(studio x5s heygen 0.20)" ok "X5 studio avatar call reserved on heygen (1 in flight)"
op x5a $AV heygen 0.20 RESERVED; eq "$(submit x5a)" concurrency "X5 platform avatar call refused while the studio call is in flight"
studio_set x5s settled 0.20
eq "$(submit x5a)" admitted "X5 admitted once the studio call settled"
eq "$(studio x5s2 heygen 0.20)" "STUDIO_CAP: concurrency" "X5 reverse: studio call refused while the platform avatar call is SUBMITTED"
$Q -c "update public.pi_paid_operations set status='COMMITTED', committed_usd=0.20 where idempotency_key='x5a'"

echo "== X6 race for the last global headroom across ledgers: exactly one wins"
fresh; S0=$(spend); global_cap "$(python3 -c "print(round($S0+1.00,4))")"
op x6a $AV openai 0.60 RESERVED
( $Q -c "begin; insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (encode(sha256('x6s'::bytea),'hex'),'$U1','$SE','openai','x','reserved',0.60); select pg_sleep(2); commit;" > "$W/x6s.out" 2>&1 ) &
sleep 0.6; T0=$(date +%s.%N); B=$(submit x6a); T1=$(date +%s.%N); wait
eq "$B" "global funded spend ceiling" "X6 platform admission waited for the studio transaction and was refused (0.60 + 0.60 > 1.00)"
python3 -c "import sys; sys.exit(0 if $T1-$T0 > 1.0 else 1)" && ok "X6 the admission blocked on the global lock (waited $(python3 -c "print(round($T1-$T0,2))") s)" || bad "X6 no lock wait observed"
eq "$($Q -c "select count(*) from public.podcast_studio_operations where key=encode(sha256('x6s'::bytea),'hex')")" 1 "X6 the studio reservation (winner) is the only one"
studio_set x6s settled 0.60

echo "== X7 race between two platform modules (reel vs podcast) for the last global headroom"
fresh; S0=$(spend); global_cap "$(python3 -c "print(round($S0+1.00,4))")"
op x7r $REEL2 openai 0.60 RESERVED; op x7p $PJ openai 0.60 RESERVED
( $Q -c "begin; select public.pi_submit_with_supply('x7r', null)->>'reason'; select pg_sleep(2); commit;" > "$W/x7r.out" 2>&1 ) &
sleep 0.6; P=$(submit x7p); wait
eq "$(head -1 "$W/x7r.out")" admitted "X7 reel admitted first"
eq "$P" "global funded spend ceiling" "X7 podcast refused after waiting (shared global ceiling)"
eq "$($Q -c "select count(*) from public.pi_paid_operations where idempotency_key in ('x7r','x7p') and status='SUBMITTED'")" 1 "X7 exactly one SUBMITTED"
global_cap 100

echo "== X8 idempotency: the same key is admitted once and counted once, in both ledgers"
fresh; S0=$(spend "'openai'")
op x8 $REEL2 openai 0.05 RESERVED; eq "$(submit x8)" admitted "X8 first admission"
eq "$(submit x8)" already_claimed "X8 replay of the same key: already_claimed, no second admission"
eq "$(spend "'openai'")" "$(python3 -c "print(f'{$S0+0.05:.4f}')")" "X8 spend grew by the reservation exactly once"
eq "$(studio x8s elevenlabs 0.05)" ok "X8 studio key reserved"
eq "$(studio x8s elevenlabs 0.05)" "duplicate key" "X8 studio replay of the same key rejected by the primary key (no double reservation)"

echo "== X9 retries: an unreconciled refund still counts; a reconciled one releases the reel budget"
$Q -c "update public.pi_paid_operations set status='REFUNDED', committed_usd=0, supply_reconciled=false where idempotency_key='x1r'"
op x9a $REEL openai 0.20 RESERVED; eq "$(submit x9a)" "reel budget exceeded" "X9 retry refused while the failed 0.90 attempt is an unreconciled refund"
op x9b $REEL2 openai 0.90 REFUNDED 0 true
op x9c $REEL2 openai 0.10 RESERVED; eq "$(submit x9c)" admitted "X9 a reconciled 0.90 refund does not count: reel2 0.75 pending + 0.10 <= 1.00 admitted"
op x9d $REEL2 openai 0.20 RESERVED; eq "$(submit x9d)" "reel budget exceeded" "X9 reel2 cap still binds: 0.85 + 0.20 > 1.00"

echo "== X10 the daily call quota is shared: studio calls count toward the platform quota"
fresh; TODAY=$($Q -c "select (public.pi_supply_state('elevenlabs')->>'todayCalls')::int")
$Q -c "update public.pi_supply_policies set max_daily_calls=$((TODAY+1)) where provider='elevenlabs'"
eq "$(studio x10s elevenlabs 0.01)" ok "X10 one more studio elevenlabs call (reaches the quota)"
op x10p $REEL2 elevenlabs 0.01 RESERVED; eq "$(submit x10p)" "daily request quota" "X10 platform elevenlabs call refused: quota reached by the studio"
$Q -c "update public.pi_supply_policies set max_daily_calls=1000 where provider='elevenlabs'"

echo "== X11 project-id aliasing (defense-in-depth observation; the app always builds 'podcast-' || episode id)"
for alias in "PODCAST-$EP" " podcast-$EP"; do
  k="x11-$(echo "$alias" | md5sum | cut -c1-6)"; op "$k" "$alias" openai 0.01 RESERVED
  echo "OBS X11 project_id '$alias' -> $(submit "$k") (podcast authorization rule matches only the exact lower-case prefix)"
done
op x11u "$(echo $REEL | tr a-f A-F)" openai 0.01 RESERVED; eq "$(submit x11u)" "reel budget: project id noncanonical" "X11 reel uuid alias is refused (canonical identity enforced)"

echo "RESULT cross-module economics: $FAILS FAIL"
exit $((FAILS > 0))
