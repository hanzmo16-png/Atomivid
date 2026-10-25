#!/usr/bin/env bash
# Entorno Long Form del recorrido de cierre (USD 0, solo 127.0.0.1). Requiere infra/setup.sh ya ejecutado.
# 1) BD desechable = producción tras O1–O8: aplica las propuestas #198 (ya en prod), 120000, 130000 y 140000.
# 2) Topes LOCALES de voz/imagen del arnés (nunca producción). 3) Worker real (runRenderJob) con adaptadores reales
# ElevenLabs/Pexels/OpenAI redirigidos a mocks loopback (worker-longform.ts); claves falsas. 4) Next + mocks.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(git -C "$HERE" rev-parse --show-toplevel); E2E_HOME=${E2E_HOME:-$REPO/.e2e-local}
. "$E2E_HOME/paths.env"; L="$E2E_HOME/logs"; PS="psql -h $E2E_HOME/run -p $PGPORT -U postgres -d atomivid -v ON_ERROR_STOP=1 -q"
if [ ! -f "$E2E_HOME/.lf-proposals.done" ]; then
  for n in 20261024000000_spend_authorizations 20261024120000_resume_authorization_ref_match 20261024130000_spend_authorization_baseline_fix 20261024140000_podcast_v3_studio; do
    echo "aplica propuesta $n (BD desechable)"; $PS -f "$REPO/supabase/proposals/$n.sql" > "$L/prop-$n.log" 2>&1; done
  $PS -f "$REPO/scripts/harness/e2e/longform-rehearsal/seed-elevenlabs-local.sql"
  $PS -c "update public.pi_supply_policies set enabled=true, unit='usd', unit_cost_usd=1, baseline=50, daily_forecast=1, daily_cap_usd=20, monthly_cap_usd=50, max_concurrent=4, max_daily_calls=500, evidence='arnés local E2E USD 0 (imágenes simuladas)' where provider='openai';
           insert into public.pi_capacity_snapshots(provider,unit,available,reserved,pending,health,reliability,status,checked_at) values ('openai','usd',50,0,0,'OK','manual_entry','GREEN',now());"
  touch "$E2E_HOME/.lf-proposals.done"
fi
OWNER=$(node -e 'console.log(require(process.argv[1])[0].id)' "$REPO/scripts/harness/e2e/infra/users.json")
OWNER_EMAIL=$(node -e 'console.log(require(process.argv[1])[0].email)' "$REPO/scripts/harness/e2e/infra/users.json")
grep -q '^MOCK_LF_URL=' "$E2E_HOME/secrets/next.env" || cat >> "$E2E_HOME/secrets/next.env" <<ENV
MOCK_LF_URL=http://127.0.0.1:54610
REEL_VOICE_SELECTION_ENABLED=true
PRIVATE_VOICE_GRANTS=CeFSZuaHs4SxcBxb9nCr=$OWNER_EMAIL
ELEVENLABS_API_KEY=local-fake-el
ENV
# LONG_FORM_REAL_RUN_CONFIRM: el worker exige esta confirmación para usar los adaptadores reales. Aquí es inocua: las claves son
# falsas y worker-longform.ts redirige esos hosts a los mocks loopback y RECHAZA cualquier otra salida (registrada en egress.jsonl).
cat > "$L/worker-env-override.json" <<JSON
{"WORKER_SCRIPT":"scripts/harness/e2e/worker-longform.ts","MOCK_LF_URL":"http://127.0.0.1:54610","VOICE_PROVIDER":"elevenlabs","ELEVENLABS_API_KEY":"local-fake-el",
 "FOOTAGE_PROVIDER":"pexels","PEXELS_API_KEY":"local-fake-pexels","IMAGE_PROVIDER":"openai","OPENAI_API_KEY":"local-fake-openai","IMAGE_GENERATION_ENABLED":"true",
 "MUSIC_PROVIDER":"curated-library","MUSIC_TRACK_URL":"http://127.0.0.1:54610/media/musica-sintetica.mp3","LONG_FORM_REAL_RUN_CONFIRM":"YES_SPEND_REAL_MONEY","ATOMIVID_WORKER_LOCAL_FIXTURE":null,"E2E_EGRESS_LOG":"$L/egress.jsonl"}
JSON
pkill -f mock-longform-providers.mjs || true
mkdir -p "$E2E_HOME/media"; echo '{}' > "$E2E_HOME/faults.json"
# Música SINTÉTICA (acordes con trémolo, 6 min) servida por el mock en loopback como «biblioteca curada» de una sola pista.
[ -f "$E2E_HOME/media/musica-sintetica.mp3" ] || ffmpeg -v error -y -f lavfi -i "sine=f=220:d=360" -f lavfi -i "sine=f=277.18:d=360" -f lavfi -i "sine=f=329.63:d=360" \
  -filter_complex "[0][1][2]amix=inputs=3,tremolo=f=0.25:d=0.6,volume=0.5" -ar 44100 -c:a libmp3lame -b:a 160k "$E2E_HOME/media/musica-sintetica.mp3"
MEDIA_DIR="$E2E_HOME/media" MOCK_LOG="$L/mock-lf.jsonl" PIPER_BIN="$HERE/piper-espeak.sh" PIPER_VOICE=es FAULTS_FILE="$E2E_HOME/faults.json" \
  nohup node "$REPO/scripts/harness/e2e/infra/mock-longform-providers.mjs" > "$L/mock-lf.log" 2>&1 &
bash "$REPO/scripts/harness/e2e/infra/start.sh"
for i in $(seq 1 20); do curl -sf -o /dev/null http://127.0.0.1:54610/el/v1/voices && break; sleep 1; done
curl -s http://127.0.0.1:54610/el/v1/voices | head -c 120; echo
