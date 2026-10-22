#!/usr/bin/env bash
# Entorno LOCAL del E2E de Podcast 2.1 en puertos PROPIOS (no choca con otro arnés que use 3001/3100/54321):
# PG 55532 · PostgREST 3201 · gateway 54821 · mock ElevenLabs 54870 · mock Pexels 54872 · receptor de despacho 54871 · Next 3300. USD 0.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(git -C "$HERE" rev-parse --show-toplevel); E2E_HOME=${E2E_HOME:-$REPO/.e2e-local}; INFRA="$HERE/../infra"
. "$E2E_HOME/paths.env"; NODE_DIR="${NODE22_DIR:-$E2E_HOME/bin/node-v22.12.0-linux-x64}"; [ -x "$NODE_DIR/bin/node" ] && export PATH="$NODE_DIR/bin:$PATH"
set -a; . "$E2E_HOME/secrets/jwt.env"; set +a
L="$E2E_HOME/logs"; R="$E2E_HOME/run"; mkdir -p "$R"
# Parada SOLO de procesos propios por PID registrado (nunca pkill por patrón: otro arnés puede compartir la máquina).
for f in "$R"/podcast-*.pid; do [ -f "$f" ] || continue; pid=$(cat "$f"); kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; rm -f "$f"; done; sleep 1
bg() { local name=$1; shift; setsid nohup "$@" > "$L/$name.log" 2>&1 & echo $! > "$R/podcast-$name.pid"; }
"$PG_BIN/pg_ctl" -D "$E2E_HOME/pg" status >/dev/null 2>&1 || "$PG_BIN/pg_ctl" -D "$E2E_HOME/pg" -o "-p $PGPORT -k $E2E_HOME/run -c listen_addresses=localhost" -l "$L/pg.log" -w start >/dev/null
PGURL="postgres://postgres@localhost:$PGPORT/atomivid?host=$E2E_HOME/run"
# La PROPUESTA de migración se aplica SOLO a esta base local desechable (nunca a un proyecto real).
psql -q -v ON_ERROR_STOP=1 "$PGURL" -f "$REPO/supabase/proposals/20261021200000_podcast_v2_production.sql" >/dev/null
psql -q -v ON_ERROR_STOP=1 "$PGURL" -f "$HERE/seed-supply.sql" >/dev/null
sed 's/^server-port = .*/server-port = 3201/' "$E2E_HOME/secrets/pgrst.conf" > "$E2E_HOME/secrets/pgrst-podcast.conf"
bg postgrest "$E2E_HOME/bin/postgrest" "$E2E_HOME/secrets/pgrst-podcast.conf"
GW_PORT=54821 PGRST_PORT=3201 GW_STORAGE_DIR="$E2E_HOME/storage" GW_LOG="$L/gateway.jsonl" GW_USERS="$INFRA/users.json" bg gateway node "$INFRA/gateway.mjs"
MOCK_LOG="$L/elevenlabs.jsonl" MOCK_FAIL="$E2E_HOME/run/el-fail" bg mock-el node "$HERE/mock-elevenlabs.mjs"
MOCK_LOG="$L/pexels.jsonl" MOCK_MEDIA_DIR="$E2E_HOME/synth/pexels" bg mock-pexels node "$HERE/mock-pexels.mjs"
bg dispatch node -e 'require("http").createServer((q,s)=>{let b="";q.on("data",d=>b+=d);q.on("end",()=>{require("fs").appendFileSync(process.argv[1],b+"\n");s.end()})}).listen(54871,"127.0.0.1")' "$L/dispatch.jsonl"
# Música: biblioteca local si existe; si no (CI), pistas sintéticas generadas aquí con los nombres de la biblioteca.
MUSIC=${PODCAST_MUSIC_DIR:-/workspace/reels-libro/musica}
if [ ! -d "$MUSIC" ]; then MUSIC="$E2E_HOME/synth/musica"; mkdir -p "$MUSIC"
  (cd "$REPO" && npx tsx -e 'import { PODCAST_MUSIC_LIBRARY as L } from "./src/lib/podcast/v2/music"; console.log(L.map((t) => t.file).join("\n"))') | while read -r f; do [ -n "$f" ] && [ ! -f "$MUSIC/$f" ] && ffmpeg -nostdin -v error -y -f lavfi -i "sine=f=220:d=240,volume=0.3" -f lavfi -i "sine=f=330:d=240,volume=0.2" -filter_complex amix=inputs=2 -b:a 96k "$MUSIC/$f"; done; fi
cd "$REPO"; set -a; . "$E2E_HOME/secrets/next.env"; set +a
export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54821 ELEVENLABS_API_KEY=local-fake-elevenlabs VOICE_PROVIDER=elevenlabs PODCAST_V2_ENABLED=1 \
  PRIVATE_VOICE_GRANTS="DuroPruebaLocal03=pilot-owner@local.test" AVATAR_PREPARATION_OWNER_EMAIL=intruso@local.test PODCAST_MUSIC_DIR=$MUSIC \
  MOCK_EL_URL=http://127.0.0.1:54870 MOCK_PEXELS_URL=http://127.0.0.1:54872 PEXELS_API_KEY=local-fake-pexels E2E_DISPATCH_URL=http://127.0.0.1:54871/ RENDER_WORKER=github-actions E2E_EGRESS_LOG="$L/egress.jsonl" NODE_OPTIONS="--require $INFRA/next-intercept.cjs" NEXT_TELEMETRY_DISABLED=1
env | grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|NEXT_PUBLIC_SUPABASE_ANON_KEY|ELEVENLABS_API_KEY|PRIVATE_VOICE_GRANTS|PODCAST_V2_ENABLED|PODCAST_MUSIC_DIR|INTERNAL_PRODUCTION_OWNER_USER_ID|MOCK_EL_URL|MOCK_PEXELS_URL|PEXELS_API_KEY|NODE_OPTIONS|E2E_EGRESS_LOG)=' > "$E2E_HOME/secrets/podcast-worker.env"; chmod 600 "$E2E_HOME/secrets/podcast-worker.env"
bg next npx next dev -p 3300 -H 127.0.0.1
for i in $(seq 1 90); do curl -s -o /dev/null --max-time 120 http://127.0.0.1:3300/login && break; sleep 2; done
curl -s -o /dev/null -w "next %{http_code}\n" --max-time 180 http://127.0.0.1:3300/login
