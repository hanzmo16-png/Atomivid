#!/usr/bin/env bash
# Crea una BD efímera con el esquema real (todas las migraciones aplicadas por infra/setup.sh), ejecuta la suite y la borra.
# Uso: scripts/harness/adversarial/run.sh [archivo-de-ledger-alternativo-para-RED]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
E2E_HOME=${E2E_HOME:-$ROOT/.e2e-local}
source "$E2E_HOME/paths.env"
PGH=${PGHOST_ADV:-127.0.0.1}; SRC_DB=${ADV_SRC_DB:-atomivid}
DB=adv_$(date +%s)_$$
"$PG_BIN/createdb" -h "$PGH" -p "$PGPORT" -U postgres "$DB"
trap '"$PG_BIN/dropdb" -h "$PGH" -p "$PGPORT" -U postgres --if-exists "$DB" >/dev/null' EXIT
"$PG_BIN/pg_dump" -h "$PGH" -p "$PGPORT" -U postgres --schema-only "$SRC_DB" | "$PG_BIN/psql" -q -h "$PGH" -p "$PGPORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 >/dev/null 2>"$E2E_HOME/logs/adv-schema.err"
export ADV_PG_URL="postgres://postgres@$PGH:$PGPORT/$DB" HARNESS_PG_MODULE="$E2E_HOME/deps/node_modules/pg" SUPPLY_GUARD_ENFORCED=true
cd "$ROOT"
# Sin `exec`: el trap EXIT debe ejecutarse para borrar la BD efímera. Se conserva el código de salida de node.
rc=0
node --import tsx --test --test-concurrency=1 scripts/harness/adversarial/ledger-adversarial.pg.test.ts || rc=$?
exit "$rc"
