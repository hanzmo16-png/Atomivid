#!/usr/bin/env bash
# Arranca (o reinicia) el entorno local del E2E: Postgres, PostgREST, gateway, mocks, worker de prueba, Next. Sólo 127.0.0.1.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(git -C "$HERE" rev-parse --show-toplevel); E2E_HOME=${E2E_HOME:-$REPO/.e2e-local}
. "$E2E_HOME/paths.env"; NODE_DIR="$E2E_HOME/bin/node-v22.12.0-linux-x64"; [ -x "$NODE_DIR/bin/node" ] && export PATH="$NODE_DIR/bin:$PATH"
set -a; . "$E2E_HOME/secrets/jwt.env"; set +a
L="$E2E_HOME/logs"; for p in "next dev -p 3100" worker-receiver.mjs mock-anthropic.mjs mock-openai.mjs gateway.mjs "postgrest $E2E_HOME"; do pkill -f "$p" || true; done; sleep 1
# Puertos fijos: si otro checkout (otro $E2E_HOME) aún los ocupa, abortar en vez de hablar con su PostgREST (JWT distinto).
for port in 3001 3100 54321 54400 54500 54600; do ss -ltn "sport = :$port" | grep -q LISTEN && { echo "Puerto $port ocupado por otro proceso (¿otro checkout del arnés?): detenlo antes"; exit 1; }; done
"$PG_BIN/pg_ctl" -D "$E2E_HOME/pg" status >/dev/null 2>&1 || "$PG_BIN/pg_ctl" -D "$E2E_HOME/pg" -o "-p $PGPORT -k $E2E_HOME/run -c listen_addresses=localhost" -l "$L/pg.log" -w start >/dev/null
nohup "$E2E_HOME/bin/postgrest" "$E2E_HOME/secrets/pgrst.conf" > "$L/postgrest.log" 2>&1 &
GW_STORAGE_DIR="$E2E_HOME/storage" GW_LOG="$L/gateway.jsonl" GW_USERS="$HERE/users.json" nohup node "$HERE/gateway.mjs" > "$L/gateway.log" 2>&1 &
MOCK_LOG="$L/anthropic.jsonl" nohup node "$HERE/mock-anthropic.mjs" > "$L/mock-anthropic.log" 2>&1 &
SYNTH_DIR="$E2E_HOME/synth" MOCK_LOG="$L/openai.jsonl" nohup node "$HERE/mock-openai.mjs" > "$L/mock-openai.log" 2>&1 &
APP_ROOT="$REPO" LOGDIR="$L" WORKER_ENV="$E2E_HOME/secrets/worker-env.json" nohup node "$HERE/worker-receiver.mjs" > "$L/receiver.log" 2>&1 &
cd "$REPO"; set -a; . "$E2E_HOME/secrets/next.env"; set +a
export RENDER_WORKER=github-actions E2E_EGRESS_LOG="$L/egress.jsonl" NODE_OPTIONS="--require $HERE/next-intercept.cjs" NEXT_TELEMETRY_DISABLED=1
nohup npx next dev -p 3100 -H 127.0.0.1 > "$L/next.log" 2>&1 &
for i in $(seq 1 60); do curl -s -o /dev/null --max-time 120 http://127.0.0.1:3100/login && break; sleep 2; done
curl -s -o /dev/null -w "next %{http_code}\n" --max-time 120 http://127.0.0.1:3100/login
