#!/usr/bin/env bash
# USD 0. PostgreSQL DESECHABLE (dir temporal, puerto propio, socket unix, sin TCP) construido con las migraciones del repo +
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
DB=atomivid_cierre; PS="psql -h $W/run -p $P -U postgres -v ON_ERROR_STOP=1 -q"
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
cd "$R" && PGHOST=$W/run PGPORT=$P DB=$DB OUT_DIR=${OUT_DIR:-$R/podcast-cierre-out} npx tsx scripts/qa/podcast-cierre-e2e.ts
