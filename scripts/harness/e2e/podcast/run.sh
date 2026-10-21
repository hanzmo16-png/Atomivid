#!/usr/bin/env bash
# Uso: run.sh <salida> <casos>   (requiere podcast/start.sh en marcha)
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(git -C "$HERE" rev-parse --show-toplevel); E2E_HOME=${E2E_HOME:-$REPO/.e2e-local}
. "$E2E_HOME/paths.env"; NODE_DIR="${NODE22_DIR:-$E2E_HOME/bin/node-v22.12.0-linux-x64}"; [ -x "$NODE_DIR/bin/node" ] && export PATH="$NODE_DIR/bin:$PATH"
OUT="$E2E_HOME/out/$1"; mkdir -p "$OUT"
REPO="$REPO" E2E_HOME="$E2E_HOME" E2E_OUT="$OUT" E2E_CHROME="$CHROME" PLAYWRIGHT_MODULE="$E2E_HOME/deps/node_modules/playwright" HARNESS_PG_MODULE="$E2E_HOME/deps/node_modules/pg" \
HARNESS_PG_URL="postgres://postgres@localhost:$PGPORT/atomivid?host=$E2E_HOME/run" timeout ${E2E_TIMEOUT:-5400} node "$HERE/podcast-e2e.cjs" "$2" 2>&1 | tee "$OUT.log"
