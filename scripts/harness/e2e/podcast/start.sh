#!/usr/bin/env bash
# Entorno LOCAL del E2E de Podcast 2.1 en puertos PROPIOS (no choca con otro arnés que use 3001/3100/54321):
# PG 55532 · PostgREST 3201 · gateway 54821 · mock ElevenLabs 54870 · receptor de despacho 54871 · Next 3300. USD 0.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(git -C "$HERE" rev-parse --show-toplevel); E2E_HOME=${E2E_HOME:-$REPO/.e2e-local}; INFRA="$HERE/../infra"
. "$E2E_HOME/paths.env"; NODE_DIR="${NODE22_DIR:-$E2E_HOME/bin/node-v22.12.0-linux-x64}"; [ -x "$NODE_DIR/bin/node" ] && export PATH="$NODE_DIR/bin:$PATH"
set -a; . "$E2E_HOME/secrets/jwt.env"; set +a
L="$E2E_HOME/logs"; for p in "next dev -p 3300" "mock-elevenlabs.mjs" "GW_PORT=54821" "pgrst-podcast.conf" "dispatch-log-54871"; do pkill -f "$p" || true; done; sleep 1
"$PG_BIN/pg_ctl" -D "$E2E_HOME/pg" status >/dev/null 2>&1 || "$PG_BIN/pg_ctl" -D "$E2E_HOME/pg" -o "-p $PGPORT -k $E2E_HOME/run -c listen_addresses=localhost" -l "$L/pg.log" -w start >/dev/null
psql -q "postgres://postgres@localhost:$PGPORT/atomivid?host=$E2E_HOME/run" -f "$HERE/seed-supply.sql" >/dev/null 2>&1 || echo "aviso: seed-supply no aplicado"
sed 's/^server-port = .*/server-port = 3201/' "$E2E_HOME/secrets/pgrst.conf" > "$E2E_HOME/secrets/pgrst-podcast.conf"
nohup "$E2E_HOME/bin/postgrest" "$E2E_HOME/secrets/pgrst-podcast.conf" > "$L/postgrest.log" 2>&1 &
GW_PORT=54821 PGRST_PORT=3201 GW_STORAGE_DIR="$E2E_HOME/storage" GW_LOG="$L/gateway.jsonl" GW_USERS="$INFRA/users.json" nohup node "$INFRA/gateway.mjs" > "$L/gateway.log" 2>&1 &
MOCK_LOG="$L/elevenlabs.jsonl" MOCK_FAIL="$E2E_HOME/run/el-fail" nohup node "$HERE/mock-elevenlabs.mjs" > "$L/mock-el.log" 2>&1 &
nohup node -e 'require("http").createServer((q,s)=>{let b="";q.on("data",d=>b+=d);q.on("end",()=>{require("fs").appendFileSync(process.argv[1],b+"\n");s.end()})}).listen(54871,"127.0.0.1")' "$L/dispatch.jsonl" dispatch-log-54871 > /dev/null 2>&1 &
cd "$REPO"; set -a; . "$E2E_HOME/secrets/next.env"; set +a
export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54821 ELEVENLABS_API_KEY=local-fake-elevenlabs VOICE_PROVIDER=elevenlabs PODCAST_V2_ENABLED=1 \
  PRIVATE_VOICE_GRANTS="DuroPruebaLocal03=pilot-owner@local.test" AVATAR_PREPARATION_OWNER_EMAIL=intruso@local.test PODCAST_MUSIC_DIR=${PODCAST_MUSIC_DIR:-/workspace/reels-libro/musica} \
  MOCK_EL_URL=http://127.0.0.1:54870 E2E_DISPATCH_URL=http://127.0.0.1:54871/ RENDER_WORKER=github-actions E2E_EGRESS_LOG="$L/egress.jsonl" NODE_OPTIONS="--require $INFRA/next-intercept.cjs" NEXT_TELEMETRY_DISABLED=1
env | grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|NEXT_PUBLIC_SUPABASE_ANON_KEY|ELEVENLABS_API_KEY|PRIVATE_VOICE_GRANTS|PODCAST_V2_ENABLED|PODCAST_MUSIC_DIR|INTERNAL_PRODUCTION_OWNER_USER_ID|MOCK_EL_URL|NODE_OPTIONS|E2E_EGRESS_LOG)=' > "$E2E_HOME/secrets/podcast-worker.env"; chmod 600 "$E2E_HOME/secrets/podcast-worker.env"
nohup npx next dev -p 3300 -H 127.0.0.1 > "$L/next.log" 2>&1 &
for i in $(seq 1 90); do curl -s -o /dev/null --max-time 120 http://127.0.0.1:3300/login && break; sleep 2; done
curl -s -o /dev/null -w "next %{http_code}\n" --max-time 180 http://127.0.0.1:3300/login
