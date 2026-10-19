#!/usr/bin/env bash
# Uso: run-e2e.sh <salida> [RED]   (E2E_SCRIPT=reel-browser-e2e.cjs | reel-images-e2e.cjs). Exit ≠ 0 si falla una aserción.
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(git -C "$HERE" rev-parse --show-toplevel); E2E_HOME=${E2E_HOME:-$REPO/.e2e-local}
. "$E2E_HOME/paths.env"; NODE_DIR="$E2E_HOME/bin/node-v22.12.0-linux-x64"; [ -x "$NODE_DIR/bin/node" ] && export PATH="$NODE_DIR/bin:$PATH"
OUT="$E2E_HOME/out/$1"; rm -rf "$OUT"; [ "${2:-}" = RED ] && export E2E_RED=1
cd "$REPO"
E2E_CHROME="$CHROME" E2E_OUT="$OUT" E2E_DIR="$E2E_HOME" PLAYWRIGHT_MODULE="$E2E_HOME/deps/node_modules/playwright" HARNESS_PG_MODULE="$E2E_HOME/deps/node_modules/pg" \
HARNESS_PG_URL="postgres://postgres@localhost:$PGPORT/atomivid?host=$E2E_HOME/run" timeout 1800 node "$HERE/../${E2E_SCRIPT:-reel-browser-e2e.cjs}" > "$OUT.log" 2>&1
code=$?; echo "exit=$code" >> "$OUT.log"; echo "exit=$code"; grep -E "^FAIL|RESULTADO" "$OUT.log"; exit $code
