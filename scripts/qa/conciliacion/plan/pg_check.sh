#!/usr/bin/env bash
# USD 0. Cross-checks plan.py against the REAL proposed tool (docs/ops/conciliacion/pi_reconcile_open_operation.sql) on a
# DISPOSABLE PostgreSQL cluster with synthetic rows only (no production connection exists in this script):
# every READY decision of the plan is accepted by the tool with the SAME decision_sha256, replays are idempotent,
# contradictory plans are refused, the snapshot totals and the pi_supply_spend delta match the plan.
# Usage: bash scripts/qa/conciliacion/plan/pg_check.sh [workdir] [port]
set -uo pipefail
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel); W=${1:-$(mktemp -d)}; P=${2:-55981}
PB=${PG_BIN:-$( (pg_config --bindir 2>/dev/null) || ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}
mkdir -p "$W/logs" "$W/run"
"$PB/initdb" -D "$W/pg" -U postgres --auth=trust >/dev/null
"$PB/pg_ctl" -D "$W/pg" -o "-p $P -k $W/run -c listen_addresses=''" -l "$W/logs/pg.log" -w start >/dev/null
trap '"$PB/pg_ctl" -D "$W/pg" -m fast stop >/dev/null 2>&1 || true' EXIT
Q="$PB/psql -h $W/run -p $P -U postgres -X -q -v ON_ERROR_STOP=1"
$Q -d postgres -c "create database plan" >/dev/null
$Q -d plan -f "$R/scripts/harness/e2e/infra/stubs.sql" >/dev/null 2>&1
$Q -d plan -c "create table video_requests(id uuid primary key,user_id uuid,mode text not null,status text default 'processing',render_attempts integer default 1,progress_stage text,error_message text);
  create table documentary_script_jobs(id uuid primary key,user_id uuid,status text);
  create table podcast_episodes(id uuid primary key,status text,run_token uuid,video_status text,video_run_token uuid);" >/dev/null
echo "0b49d9a4752d19c1b6f6f24df6c3f0c6fbdbd39136a41832f5a6189aa7fa8131  $R/scripts/qa/fixtures/0023-production-intelligence.sql" | sha256sum -c --quiet || { echo "FAIL 0023 checksum"; exit 1; }
$Q -d plan -f "$R/scripts/qa/fixtures/0023-production-intelligence.sql" >/dev/null
for m in 20261005143935_provider_supply_controls 20261005145807_provider_supply_settlement_clock 20261005150229_provider_supply_job_reservations; do
  $Q -d plan -f "$R/supabase/migrations/$m.sql" >/dev/null || { echo "FAIL migration $m"; exit 1; }; done
(cd "$R" && sha256sum -c --quiet docs/ops/conciliacion/SHA256SUMS) || { echo "FAIL tool files do not match SHA256SUMS"; exit 1; }
$Q -d plan -f "$R/docs/ops/conciliacion/pi_reconcile_open_operation.sql" >/dev/null || { echo "FAIL tool does not apply"; exit 1; }
echo "INFO disposable cluster: ledger DDL + 3 supply migrations + tool $(sha256sum "$R/docs/ops/conciliacion/pi_reconcile_open_operation.sql" | cut -c1-12)"
PSQL="$Q -d plan" python3 -I "$R/scripts/qa/conciliacion/plan/pg_check.py" "$W"
