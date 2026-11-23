#!/usr/bin/env bash
# E2E autenticado del cliente misterioso en el arnés local (ATOMIVID de este checkout, USD 0, sin salida a proveedores).
# Uso: run.sh <salida>. Levanta el entorno de Podcast (Next 3300 + gateway 54821) con el destino local permitido.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(git -C "$HERE" rev-parse --show-toplevel); E2E_HOME=${E2E_HOME:-$REPO/.e2e-local}
. "$E2E_HOME/paths.env"; NODE_DIR="${NODE22_DIR:-$E2E_HOME/bin/node-v22.12.0-linux-x64}"; [ -x "$NODE_DIR/bin/node" ] && export PATH="$NODE_DIR/bin:$PATH"
export MYSTERY_SHOPPER_ALLOW_LOCAL=1 MYSTERY_SHOPPER_TARGET_URL=http://127.0.0.1:3300 GH_WORKER_TOKEN=local-fake-token GH_WORKER_REPO=local/test
bash "$HERE/../podcast/start.sh"
OUT="$E2E_HOME/out/mystery-shopper/$1"; rm -rf "$OUT"; mkdir -p "$OUT"
REPO="$REPO" E2E_HOME="$E2E_HOME" E2E_OUT="$OUT" E2E_CHROME="$CHROME" PLAYWRIGHT_MODULE="$E2E_HOME/deps/node_modules/playwright" \
  timeout ${E2E_TIMEOUT:-2400} node "$HERE/run.cjs" 2>&1 | tee "$OUT.log"
