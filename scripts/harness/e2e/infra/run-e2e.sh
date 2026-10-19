#!/bin/bash
# Uso: run-e2e.sh <outdir> [RED]
cd /workspace/tmp/grok-e2e; export PATH=$PWD/bin/node-v22.12.0-linux-x64/bin:$PATH
rm -rf "out/$1"; [ "$2" = RED ] && export E2E_RED=1
E2E_CHROME=/workspace/tmp/Atomivid/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell \
E2E_OUT="out/$1" E2E_DIR=$PWD PLAYWRIGHT_MODULE=/workspace/tmp/grok-harness/node_modules/playwright HARNESS_PG_MODULE=/workspace/tmp/grok-harness/node_modules/pg \
HARNESS_PG_URL="postgres://postgres@localhost:55432/atomivid?host=/tmp" timeout 1500 node /workspace/tmp/Atomivid/scripts/harness/e2e/${E2E_SCRIPT:-reel-browser-e2e.cjs} > "out/$1.log" 2>&1
code=$?; echo "exit=$code" >> "out/$1.log"; echo "exit=$code"; grep -E "^FAIL|RESULTADO" "out/$1.log"
