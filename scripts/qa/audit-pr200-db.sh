#!/usr/bin/env bash
# USD 0. Audit of PR #200 (claude/audit-pr200): same disposable PostgreSQL as podcast-cierre-db.sh, then adversarial SQL repros.
# las PROPUESTAS #198 (pi_spend_authorizations) y Podcast 3.0 (estudio + tope en BD), y luego el E2E de cierre
# scripts/qa/podcast-cierre-e2e.ts. Nunca toca otra base. Para solo procesos propios (pg_ctl por data dir; nada de pkill).
# Uso: bash scripts/qa/podcast-cierre-db.sh [workdir] [port]
set -euo pipefail
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel); W=${1:-$(mktemp -d)}; P=${2:-55911}
PB=${PG_BIN:-$( (pg_config --bindir 2>/dev/null) || ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}
mkdir -p "$W/logs" "$W/run"
"$PB/initdb" -D "$W/pg" -U postgres --auth=trust >/dev/null
"$PB/pg_ctl" -D "$W/pg" -o "-p $P -k $W/run -c listen_addresses=''" -l "$W/logs/pg.log" -w start >/dev/null
trap '"$PB/pg_ctl" -D "$W/pg" -m fast stop >/dev/null 2>&1 || true' EXIT
DB=atomivid_audit200; PS="psql -h $W/run -p $P -U postgres -v ON_ERROR_STOP=1 -q"
$PS -d postgres -c "create database $DB"
$PS -d $DB -f "$R/scripts/harness/e2e/infra/stubs.sql" >/dev/null
git -C "$R" cat-file -e 9dccd68c3b06bffab2dc91ab415de6c2a73062bd 2>/dev/null || git -C "$R" fetch -q origin 9dccd68c3b06bffab2dc91ab415de6c2a73062bd
git -C "$R" show 9dccd68c3b06bffab2dc91ab415de6c2a73062bd:supabase/migrations/0023_production_intelligence.sql > "$W/run/0023.sql"
echo "0b49d9a4752d19c1b6f6f24df6c3f0c6fbdbd39136a41832f5a6189aa7fa8131  $W/run/0023.sql" | sha256sum -c --quiet
KNOWN="20261011020000_pilot_scheduler.sql 20261014183400_finished_podcast_image_slot.sql" # mismas fallas solo-locales que setup.sh
d23=0; for f in $(ls "$R"/supabase/migrations/*.sql | sort); do b=$(basename "$f")
  if [ "$b" \> "0019_long_form_production_plan.sql" ] && [ $d23 = 0 ]; then $PS -d $DB -f "$W/run/0023.sql" > "$W/logs/mig-0023.log" 2>&1; d23=1; fi
  if ! $PS -d $DB -f "$f" > "$W/logs/mig-$b.log" 2>&1; then
    case " $KNOWN " in *" $b "*) echo "NOTICE migración solo-local omitida: $b";; *) echo "FAIL migración $b"; cat "$W/logs/mig-$b.log"; exit 1;; esac; fi
done
$PS -d $DB -f "$R/scripts/harness/e2e/infra/seed-config.sql" >/dev/null
$PS -d $DB -f "$R/supabase/proposals/20261024000000_spend_authorizations.sql" >/dev/null
$PS -d $DB -f "$R/supabase/proposals/20261023120000_podcast_v3_studio.sql" >/dev/null
$PS -d $DB -f "$R/supabase/proposals/20261023120000_podcast_v3_studio.sql" >/dev/null   # re-ejecutable
$PS -d $DB <<'SQL'
update public.pi_supply_policies set enabled=true, unit='character', unit_cost_usd=0.0002, baseline=63002, daily_forecast=1,
  daily_cap_usd=20, monthly_cap_usd=150, max_concurrent=4, max_daily_calls=40, timezone='America/Cancun', evidence='local test' where provider='elevenlabs';
update public.pi_supply_policies set daily_cap_usd=40, monthly_cap_usd=300 where provider='__global__';
SQL
echo "esquema base: $(ls "$R"/supabase/migrations/*.sql | wc -l) migraciones + propuestas #198 y Podcast 3.0, $("$PB/postgres" --version)"
Q="psql -h $W/run -p $P -U postgres -d $DB -v ON_ERROR_STOP=1 -qAt"
FAILS=0; ok(){ echo "PASS $*"; }; bad(){ echo "FAIL $*"; FAILS=$((FAILS+1)); }; repro(){ echo "REPRO $*"; }
U1=aaaaaaaa-0000-4000-8000-0000000000a1; EP=2a000000-0000-4000-8000-0000000000f1; PJ=podcast-$EP; SE=3b000000-0000-4000-8000-0000000000f2
$Q <<SQL
insert into auth.users(id,email) values ('$U1','hans@x') on conflict do nothing;
insert into public.podcast_episodes(id,user_id,title,source,script,voice_id,characters,estimated_usd) values ('$EP','$U1','audit','tts','x','v',2500,0.50);
insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at) values ('elevenlabs','character',500000,'OK','provider_api','GREEN',clock_timestamp());
update public.pi_supply_policies set max_daily_calls=100 where provider='elevenlabs';
SQL
op() { $Q -c "insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,capacity_units)
 values ('$1','$2','voice:$1','elevenlabs','eleven_multilingual_v2','tts_with_timestamps','initial',$3,'RESERVED',round($3/0.0002))"; }
submit() { $Q -c "select public.pi_submit_with_supply('$1', null)->>'reason'"; }

echo "== R1 (P1) immutable per-episode authorization: narration started alone fixes the cap; the later production is stopped mid-way"
[ "$($Q -c "select public.pi_open_spend_authorization('$EP',0.50,'app:narration:x')->>'opened'")" = true ] && ok "R1 narration route opened USD 0.50 (its own estimate)" || bad "R1 open"
op n1 $PJ 0.45; [ "$(submit n1)" = admitted ] && ok "R1 narration chunk 0.45 admitted"; $Q -c "update public.pi_paid_operations set status='COMMITTED',committed_usd=0.45 where idempotency_key='n1'"
r=$($Q -c "select public.pi_open_spend_authorization('$EP',2.40,'app:production:x')->>'reason'"); [ "$r" = already_open ] && repro "R1 production route asks USD 2.40 → '$r' → ensurePodcastSpendAuthorization returns ok and the job is DISPATCHED"
op v1 $PJ 0.30; r=$(submit v1); [ "$r" = "authorization exceeded" ] && repro "R1 first paid call of the production is refused by the DB ('$r'): the job fails after dispatch; the cap can never be raised (immutable) → this episode can never be produced from the app"

echo "== R2 (P1) studio spend lives outside pi_paid_operations: aggregate caps of the rest of the platform do not see it"
$Q <<SQL
insert into public.podcast_studio_episodes(id,user_id,title,mode,spec,status,authorized_usd) values ('$SE','$U1','studio','narracion','{"version":"podcast-studio/3"}','generating',50);
insert into public.podcast_studio_operations(key,user_id,episode_id,provider,op,state,reserved_usd) values (repeat('a',64),'$U1','$SE','elevenlabs','tts','reserved',30);
update public.podcast_studio_operations set state='settled', actual_usd=30 where key=repeat('a',64);
update public.pi_supply_policies set daily_cap_usd=40 where provider='__global__';
update public.pi_supply_policies set daily_cap_usd=20 where provider='elevenlabs';
SQL
op d1 "documentary:$U1:audit" 15; r=$(submit d1)
[ "$r" = admitted ] && repro "R2 a USD 15 ElevenLabs call is admitted by pi_submit_with_supply although the studio already settled USD 30 today on ElevenLabs (provider cap 20, global 40 → real 45/40)" || ok "R2 refused ($r)"

echo "RESULT $([ $FAILS = 0 ] && echo "harness OK (REPRO lines are the findings)" || echo "$FAILS FAIL")"
exit $FAILS
