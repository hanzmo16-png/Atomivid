#!/bin/bash
# Uso: ./snap.sh <etiqueta> [requestId]  → ledger del pedido + contadores del log de llamadas (mock)
cd /workspace/atomivid-recraft/.e2e-local
R=${2:-$(node -e 'console.log(require("/workspace/atomivid-mission/lf/out/ids.json").requestId)')}
echo "== $1 $(date '+%F %T %Z') request=$R"
psql -h $PWD/run -p 55432 -U postgres -d atomivid -Atc "select provider,status,count(*),coalesce(sum(committed_usd),0),sum(reserved_usd) from pi_paid_operations where project_id='$R' group by 1,2 order by 1,2" </dev/null
echo "mock: tts=$(grep -c '"kind":"tts"' logs/mock-lf.jsonl) openai_image=$(grep -c openai_image logs/mock-lf.jsonl) pexels_search=$(grep -c pexels_.*_search logs/mock-lf.jsonl) pexels_fault=$(grep -c pexels_fault logs/mock-lf.jsonl)"
