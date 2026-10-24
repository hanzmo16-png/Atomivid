#!/usr/bin/env bash
# USD 0. Final independent audit of PR #200 (head 7153c35) — adversarial SQL on a DISPOSABLE PostgreSQL built exactly like
# scripts/qa/podcast-cierre-db.sh (repo migrations + proposals #198 → #201 → baseline fix → studio). Never touches another DB.
# PASS = protection holds · FINDING = audit finding (documented, does not fail the run) · FAIL = harness/protection broken.
# Usage: bash scripts/qa/audit-pr200-final-db.sh [workdir] [port]
set -euo pipefail
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel); W=${1:-$(mktemp -d)}; P=${2:-55931}
PB=${PG_BIN:-$( (pg_config --bindir 2>/dev/null) || ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}
mkdir -p "$W/logs" "$W/run"
"$PB/initdb" -D "$W/pg" -U postgres --auth=trust >/dev/null
"$PB/pg_ctl" -D "$W/pg" -o "-p $P -k $W/run -c listen_addresses=''" -l "$W/logs/pg.log" -w start >/dev/null
trap '"$PB/pg_ctl" -D "$W/pg" -m fast stop >/dev/null 2>&1 || true' EXIT
DB=atomivid_audit200f; PS="psql -h $W/run -p $P -U postgres -v ON_ERROR_STOP=1 -q"
$PS -d postgres -c "create database $DB"
$PS -d $DB -f "$R/scripts/harness/e2e/infra/stubs.sql" >/dev/null
git -C "$R" cat-file -e 9dccd68c3b06bffab2dc91ab415de6c2a73062bd 2>/dev/null || git -C "$R" fetch -q origin 9dccd68c3b06bffab2dc91ab415de6c2a73062bd
git -C "$R" show 9dccd68c3b06bffab2dc91ab415de6c2a73062bd:supabase/migrations/0023_production_intelligence.sql > "$W/run/0023.sql"
echo "0b49d9a4752d19c1b6f6f24df6c3f0c6fbdbd39136a41832f5a6189aa7fa8131  $W/run/0023.sql" | sha256sum -c --quiet
KNOWN="20261011020000_pilot_scheduler.sql 20261014183400_finished_podcast_image_slot.sql"
d23=0; for f in $(ls "$R"/supabase/migrations/*.sql | sort); do b=$(basename "$f")
  if [ "$b" \> "0019_long_form_production_plan.sql" ] && [ $d23 = 0 ]; then $PS -d $DB -f "$W/run/0023.sql" > "$W/logs/mig-0023.log" 2>&1; d23=1; fi
  if ! $PS -d $DB -f "$f" > "$W/logs/mig-$b.log" 2>&1; then
    case " $KNOWN " in *" $b "*) echo "NOTICE local-only migration skipped: $b";; *) echo "FAIL migration $b"; cat "$W/logs/mig-$b.log"; exit 1;; esac; fi
done
$PS -d $DB -f "$R/scripts/harness/e2e/infra/seed-config.sql" >/dev/null
for n in 20261024000000_spend_authorizations 20261024120000_resume_authorization_ref_match 20261024130000_spend_authorization_baseline_fix 20261024140000_podcast_v3_studio; do
  echo "apply proposal $n"; $PS -d $DB -f "$R/supabase/proposals/$n.sql" >/dev/null; done
$PS -d $DB <<'SQL'
update public.pi_supply_policies set enabled=true, unit='character', unit_cost_usd=0.0002, baseline=63002, daily_forecast=1,
  daily_cap_usd=20, monthly_cap_usd=150, max_concurrent=4, max_daily_calls=100, timezone='America/Cancun', evidence='audit' where provider='elevenlabs';
update public.pi_supply_policies set daily_cap_usd=40, monthly_cap_usd=300 where provider='__global__';
insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at) values ('elevenlabs','character',5000000,'OK','provider_api','GREEN',clock_timestamp());
SQL
echo "schema: $(ls "$R"/supabase/migrations/*.sql | wc -l) migrations + 4 proposals, $("$PB/postgres" --version)"
Q="psql -h $W/run -p $P -U postgres -d $DB -v ON_ERROR_STOP=1 -qAt"
PASSN=0; FAILS=0; FINDS=0
ok(){ if [ "$1" = 1 ]; then echo "PASS $2"; PASSN=$((PASSN+1)); else echo "FAIL $2 ${3:-}"; FAILS=$((FAILS+1)); fi; }
finding(){ echo "FINDING $*"; FINDS=$((FINDS+1)); }
U1=aaaaaaaa-0000-4000-8000-0000000000a1; U2=bbbbbbbb-0000-4000-8000-0000000000b2
$Q -c "insert into auth.users(id,email) values ('$U1','hans@x'),('$U2','otro@x') on conflict do nothing"
newep(){ $Q -c "insert into public.podcast_episodes(id,user_id,title,source,script,voice_id,characters,estimated_usd) values ('$1','$U1','audit $1','tts','x','v',2500,0.50)"; }
op(){ $Q -c "insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,capacity_units)
 values ('$1','$2','voice:$1','elevenlabs','eleven_multilingual_v2','tts_with_timestamps','initial',$3,'RESERVED',round($3/0.0002))"; }
submit(){ $Q -c "select coalesce(public.pi_submit_with_supply('$1', null)->>'reason', public.pi_submit_with_supply('$1', null)::text)"; }
commit(){ $Q -c "update public.pi_paid_operations set status='COMMITTED', committed_usd=$2 where idempotency_key='$1'"; }
openauth(){ $Q -c "select public.pi_open_spend_authorization('$1',$2,'audit:$3')::text"; }

echo "== E1 (defect 1) no stored authorization → the DB refuses every podcast paid call before the provider"
E1=2a000000-0000-4000-8000-0000000000e1; newep $E1; op e1k podcast-$E1 0.10
r=$(submit e1k); ok $([ "$r" = "authorization missing" ] && echo 1) "E1 call without authorization refused ('$r')"
ok $([ "$($Q -c "select status from public.pi_paid_operations where idempotency_key='e1k'")" = RESERVED ] && echo 1) "E1 refused row stays RESERVED (never SUBMITTED)"
ok $([ "$($Q -c "select count(*) from public.pi_spend_authorizations where project_id='podcast-$E1'")" = 0 ] && echo 1) "E1 no authorization created as a side effect"

echo "== E2 (defect 2) insufficient budget and narration → video under ONE immutable authorization"
E2=2a000000-0000-4000-8000-0000000000e2; newep $E2
ok $(openauth $E2 3.00 total | grep -q '"opened": true' && echo 1) "E2 owner total budget opens the episode authorization (USD 3.00)"
op e2n podcast-$E2 1.20; ok $([ "$(submit e2n)" = admitted ] && echo 1) "E2 narration call 1.20 admitted"; commit e2n 1.20
op e2v podcast-$E2 1.50; ok $([ "$(submit e2v)" = admitted ] && echo 1) "E2 video-production call 1.50 admitted under the same authorization (1.20+1.50 ≤ 3.00)"; commit e2v 1.50
op e2x podcast-$E2 0.31; r=$(submit e2x); ok $([ "$r" = "authorization exceeded" ] && echo 1) "E2 call past the cap (2.70+0.31 > 3.00) refused by the DB ('$r')"
r=$(openauth $E2 50 raise); ok $(echo "$r" | grep -q already_open && echo 1) "E2 the cap cannot be raised afterwards (immutable): $r"
ok $([ "$($Q -c "select cap_usd from public.pi_spend_authorizations where project_id='podcast-$E2'")" = 3.0000 ] || [ "$($Q -c "select cap_usd::numeric = 3 from public.pi_spend_authorizations where project_id='podcast-$E2'")" = t ] && echo 1) "E2 stored cap still 3.00"

echo "== E3 (defect 3) global and per-provider USD caps see the studio ledger, both directions"
SE=3b000000-0000-4000-8000-0000000000e3
$Q <<SQL
insert into public.podcast_studio_episodes(id,user_id,title,mode,spec,status,authorized_usd) values ('$SE','$U1','studio e3','narracion','{"version":"podcast-studio/3"}','generating',50);
insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (repeat('3',64),'$U1','$SE','elevenlabs','tts','reserved',15);
update public.podcast_studio_operations set state='settled', actual_usd=15 where key=repeat('3',64);
SQL
E3=2a000000-0000-4000-8000-0000000000e3; newep $E3; openauth $E3 20 e3 >/dev/null
op e3k podcast-$E3 3; r=$(submit e3k); ok $([ "$r" != admitted ] && echo 1) "E3 pipeline call 3 refused: pipeline 2.70 + studio settled 15 + 3 > ElevenLabs daily cap 20 ('$r')"
err=$($Q -c "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (repeat('4',64),'$U1','$SE','elevenlabs','tts','reserved',3)" 2>&1 || true)
ok $(echo "$err" | grep -q "STUDIO_CAP" && echo 1) "E3 studio reservation 3 refused by the DB (2.70+15+3 > 20): ${err:0:90}"
err=$($Q -c "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (repeat('5',64),'$U1','$SE','heygen','avatar_clip','reserved',25)" 2>&1 || true)
ok $(echo "$err" | grep -q "global funded spend ceiling\|STUDIO_CAP" && echo 1) "E3 studio reservation on another provider refused by the GLOBAL cap (17.70+25 > 40): ${err:0:90}"

echo "== E4 (defect 4) concurrency and daily-call limits shared by studio and pipeline"
$Q -c "update public.pi_supply_policies set daily_cap_usd=200, max_concurrent=2, max_daily_calls=6 where provider='elevenlabs'; update public.pi_supply_policies set daily_cap_usd=400 where provider='__global__'"
SE4=3b000000-0000-4000-8000-0000000000e4
$Q -c "insert into public.podcast_studio_episodes(id,user_id,title,mode,spec,status,authorized_usd) values ('$SE4','$U1','studio e4','narracion','{\"version\":\"podcast-studio/3\"}','generating',50)"
$Q -c "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (repeat('6',64),'$U1','$SE4','elevenlabs','tts','reserved',0.1)"
E4=2a000000-0000-4000-8000-0000000000e4; newep $E4; openauth $E4 20 e4 >/dev/null
op e4a podcast-$E4 0.1; ok $([ "$(submit e4a)" = admitted ] && echo 1) "E4 1 studio + 1 pipeline in flight (max_concurrent 2) admitted"
op e4b podcast-$E4 0.1; r=$(submit e4b); ok $([ "$r" = concurrency ] && echo 1) "E4 third in-flight call refused by concurrency (studio counted): '$r'"
err=$($Q -c "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (repeat('7',64),'$U1','$SE4','elevenlabs','tts','reserved',0.1)" 2>&1 || true)
ok $(echo "$err" | grep -q "concurrency" && echo 1) "E4 studio reservation refused by concurrency (pipeline counted): ${err:0:80}"
calls=$($Q -c "select (public.pi_supply_state('elevenlabs')->>'todayCalls')::int")
ok $([ "$calls" -ge 4 ] && echo 1) "E4 todayCalls counts studio and pipeline rows of today ($calls)"

echo "== E5 (new) two concurrent openings of the same episode authorization → exactly one row, one winner"
E5=2a000000-0000-4000-8000-0000000000e5; newep $E5
( $Q -c "begin; select public.pi_open_spend_authorization('$E5',1.00,'audit:race-a')::text; select pg_sleep(1.5); commit;" > "$W/run/race-a" 2>&1 ) &
sleep 0.3
( $Q -c "select public.pi_open_spend_authorization('$E5',5.00,'audit:race-b')::text" > "$W/run/race-b" 2>&1 ) &
wait
ok $([ "$($Q -c "select count(*) from public.pi_spend_authorizations where project_id='podcast-$E5'")" = 1 ] && echo 1) "E5 one authorization row after the race"
ok $(grep -q '"opened": true' "$W/run/race-a" && grep -q already_open "$W/run/race-b" && echo 1) "E5 first opener wins; the concurrent one waits on the row lock and gets already_open (no bigger cap slipped in)"
ok $([ "$($Q -c "select (cap_usd = 1.00)::text from public.pi_spend_authorizations where project_id='podcast-$E5'")" = true ] && echo 1) "E5 stored cap = the winner's (1.00), not 5.00"

echo "== E6 (new) worker killed: an orphan studio reservation"
$Q -c "update public.pi_supply_policies set max_concurrent=1, max_daily_calls=100 where provider='elevenlabs'"
SE6=3b000000-0000-4000-8000-0000000000e6
$Q -c "insert into public.podcast_studio_episodes(id,user_id,title,mode,spec,status,authorized_usd,run_started_at) values ('$SE6','$U1','studio e6','narracion','{\"version\":\"podcast-studio/3\"}','generating',5, now() - interval '3 days')"
$Q -c "delete from public.podcast_studio_operations where provider='elevenlabs' and state='reserved'"
$Q -c "update public.pi_paid_operations set status='COMMITTED', committed_usd=reserved_usd where status in ('SUBMITTED','RESERVED')"
$Q -c "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd,created_at,updated_at) values (repeat('8',64),'$U1','$SE6','elevenlabs','tts','reserved',0.2, now()-interval '3 days', now()-interval '3 days')"
E6=2a000000-0000-4000-8000-0000000000e6; newep $E6; openauth $E6 5 e6 >/dev/null
op e6a podcast-$E6 0.1; r=$(submit e6a)
if [ "$r" = concurrency ]; then finding "E6 (P2) a studio reservation left 'reserved' by a lost runner (mark-failed never ran) occupies a provider concurrency slot with no expiry: 3 days later a pipeline call is refused ('$r'). With max_concurrent=1 this blocks every ElevenLabs/HeyGen call platform-wide until someone reconciles it."; else ok 1 "E6 stale reservation does not block ($r)"; fi
# regression of the E6 fix: free the slot e6a took (if admitted), then a FRESH studio reservation must still hold it
$Q -c "update public.pi_paid_operations set status='COMMITTED', committed_usd=reserved_usd where idempotency_key='e6a' and status in ('SUBMITTED','RESERVED')" >/dev/null
$Q -c "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (repeat('7',64),'$U1','$SE6','elevenlabs','tts','reserved',0.05)" >/dev/null
op e6f podcast-$E6 0.1; rf=$(submit e6f); ok $([ "$rf" = concurrency ] && echo 1) "E6 a fresh studio reservation still holds the concurrency slot ('$rf')"
$Q -c "delete from public.podcast_studio_operations where key=repeat('7',64)" >/dev/null
$Q -c "update public.pi_paid_operations set status='COMMITTED', committed_usd=reserved_usd where idempotency_key='e6f' and status in ('SUBMITTED','RESERVED')" >/dev/null
# what scripts/podcast-video-mark-failed.ts does for JOB_KIND=studio, in SQL:
$Q -c "update public.podcast_studio_episodes set status='failed' where id='$SE6' and status='generating'; update public.podcast_studio_operations set state='uncertain' where episode_id='$SE6' and state='reserved'"
op e6b podcast-$E6 0.1; r=$(submit e6b); ok $([ "$r" = admitted ] && echo 1) "E6 after mark-failed (reserved → uncertain) the slot is released ('$r')"
usd=$($Q -c "select coalesce(sum(reserved_usd),0) from public.podcast_studio_operations where episode_id='$SE6' and state='uncertain'")
ok $(awk "BEGIN{exit !($usd > 0)}" && echo 1) "E6 the uncertain amount (${usd}) still counts as possibly charged (not freed)"
err=$($Q -c "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (repeat('9',64),'$U1','$SE6','elevenlabs','tts','reserved',0.1)" 2>&1 || true)
ok $(echo "$err" | grep -q "not authorized\|STUDIO_CAP" && echo 1) "E6 a failed studio episode cannot reserve again until re-authorized: ${err:0:80}"

echo "== E7 (new) Podcast 2.1: an uncertain paid call blocks opening/using a new authorization"
E7=2a000000-0000-4000-8000-0000000000e7; newep $E7
op e7a podcast-$E7 0.2; $Q -c "update public.pi_paid_operations set status='SUBMITTED' where idempotency_key='e7a'"
r=$(openauth $E7 3 e7); ok $(echo "$r" | grep -q "uncertain operations must be reconciled first" && echo 1) "E7 opening refused while a SUBMITTED (uncertain) call exists: $r"
ok $([ "$($Q -c "select count(*) from public.pi_spend_authorizations where project_id='podcast-$E7'")" = 0 ] && echo 1) "E7 nothing opened"

echo "== E8 (new) cross-owner and draft guards on the studio ledger"
SE8=3b000000-0000-4000-8000-0000000000e8
$Q -c "insert into public.podcast_studio_episodes(id,user_id,title,mode,spec,status,authorized_usd) values ('$SE8','$U1','studio e8','narracion','{\"version\":\"podcast-studio/3\"}','draft',null)"
err=$($Q -c "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (repeat('a',64),'$U1','$SE8','elevenlabs','tts','reserved',0.1)" 2>&1 || true)
ok $(echo "$err" | grep -q "not authorized" && echo 1) "E8 reservation on a draft (unauthorized) episode refused: ${err:0:70}"
$Q -c "update public.podcast_studio_episodes set status='authorized', authorized_usd=1 where id='$SE8'"
err=$($Q -c "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (repeat('b',64),'$U2','$SE8','elevenlabs','tts','reserved',0.1)" 2>&1 || true)
ok $(echo "$err" | grep -q "owner mismatch" && echo 1) "E8 reservation by another user on this episode refused: ${err:0:70}"
err=$($Q -c "insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (repeat('c',64),'$U1','$SE8','elevenlabs','tts','reserved',1.01)" 2>&1 || true)
ok $(echo "$err" | grep -q "STUDIO_CAP" && echo 1) "E8 reservation above the authorized amount (1.01 > 1.00) refused: ${err:0:70}"

echo "RESULT $PASSN PASS / $FAILS FAIL / $FINDS FINDING"
exit $FAILS
