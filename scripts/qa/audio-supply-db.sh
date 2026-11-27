#!/usr/bin/env bash
# Disposable PostgreSQL only. Never reads project .env or connects to a remote database.
set -euo pipefail
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
W=${1:?Provide a new disposable workspace}; P=${2:-55633}; PB=${PG_BIN:?Provide PostgreSQL binary directory}
mkdir -p "$W/run" "$W/logs"
"$PB/initdb" -D "$W/pg" -U postgres --auth=trust >/dev/null
"$PB/pg_ctl" -D "$W/pg" -o "-p $P -k $W/run -c listen_addresses=''" -l "$W/logs/pg.log" -w start >/dev/null
trap '"$PB/pg_ctl" -D "$W/pg" -m fast stop >/dev/null 2>&1 || true' EXIT
PS=("$PB/psql" -h "$W/run" -p "$P" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
"${PS[@]}" -f "$R/scripts/harness/e2e/infra/stubs.sql" >/dev/null
PIN=9dccd68c3b06bffab2dc91ab415de6c2a73062bd
if [[ -n "${AUDIO_SUPPLY_PI_BASELINE_SQL:-}" ]]; then
 cp "$AUDIO_SUPPLY_PI_BASELINE_SQL" "$W/run/0023.sql"
else
 git -C "$R" cat-file -e "$PIN" 2>/dev/null || git -C "$R" fetch -q origin "$PIN"
 git -C "$R" show "$PIN:supabase/migrations/0023_production_intelligence.sql" > "$W/run/0023.sql"
fi
echo "0b49d9a4752d19c1b6f6f24df6c3f0c6fbdbd39136a41832f5a6189aa7fa8131  $W/run/0023.sql" | sha256sum -c --quiet
inserted=0
for f in "$R"/supabase/migrations/*.sql; do
 b=$(basename "$f")
 [[ "$b" == 20261127050646_audio_supply_authorization_contract.sql ]] && continue
 if [[ "$b" > 0019_long_form_production_plan.sql && "$inserted" == 0 ]]; then "${PS[@]}" -f "$W/run/0023.sql" > "$W/logs/0023.log" 2>&1; inserted=1; fi
 if ! "${PS[@]}" -f "$f" > "$W/logs/$b.log" 2>&1; then
  case "$b" in 20261011020000_pilot_scheduler.sql|20261014183400_finished_podcast_image_slot.sql) echo "NOTICE known local-only extension migration: $b";; *) cat "$W/logs/$b.log";exit 1;; esac
 fi
done
# Reproduce the existing authorization and Podcast accounting wrapper chain BEFORE adding Audio.
for name in 20261024000000_spend_authorizations 20261024120000_resume_authorization_ref_match 20261024130000_spend_authorization_baseline_fix 20261024140000_podcast_v3_studio 20261028100000_pi_supply_spend_committed; do
 "${PS[@]}" -f "$R/supabase/proposals/$name.sql" > "$W/logs/$name.log" 2>&1
done
"${PS[@]}" -f "$R/supabase/migrations/20261127050646_audio_supply_authorization_contract.sql" > "$W/logs/audio-contract.log" 2>&1
PGHOST="$W/run" PGPORT="$P" PGUSER=postgres PGDATABASE=postgres node --import tsx "$R/scripts/qa/audio-supply-postgres.ts"
