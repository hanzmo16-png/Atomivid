#!/bin/bash
# Arranca el entorno local del E2E (PostgREST, gateway, mock Anthropic, worker de prueba, Next). Sólo 127.0.0.1.
cd /workspace/tmp/grok-e2e; export PATH=/workspace/tmp/grok-e2e/bin/node-v22.12.0-linux-x64/bin:$PATH; source .secret.env
pkill -f "next dev"; pkill -f worker-receiver.mjs; pkill -f mock-anthropic.mjs; pkill -f mock-openai.mjs; pkill -f gateway.mjs; pkill -f "bin/postgrest"; sleep 1
nohup ./bin/postgrest pgrst.conf > logs/postgrest.log 2>&1 &
GW_STORAGE_DIR=$PWD/storage GW_LOG=$PWD/logs/gateway.jsonl GW_USERS=$PWD/users.json nohup node gateway.mjs > logs/gateway.log 2>&1 &
MOCK_LOG=$PWD/logs/anthropic.jsonl nohup node mock-anthropic.mjs > logs/mock-anthropic.log 2>&1 &
SYNTH_DIR=$PWD/synth MOCK_LOG=$PWD/logs/openai.jsonl nohup node mock-openai.mjs > logs/mock-openai.log 2>&1 &
APP_ROOT=/workspace/tmp/Atomivid LOGDIR=$PWD/logs nohup node worker-receiver.mjs > logs/receiver.log 2>&1 &
cd /workspace/tmp/Atomivid; source ../grok-e2e/.next.env
export RENDER_WORKER=github-actions E2E_EGRESS_LOG=/workspace/tmp/grok-e2e/logs/egress.jsonl NODE_OPTIONS="--require /workspace/tmp/grok-e2e/next-intercept.cjs" NEXT_TELEMETRY_DISABLED=1
nohup npx next dev -p 3100 -H 127.0.0.1 > ../grok-e2e/logs/next.log 2>&1 &
sleep 12; curl -s -o /dev/null -w "next %{http_code}\n" --max-time 120 http://127.0.0.1:3100/login
