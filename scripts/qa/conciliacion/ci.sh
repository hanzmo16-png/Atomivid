#!/usr/bin/env bash
# USD 0. Production is ONLY read (explicit READ ONLY transaction probe; pg_dump snapshot); everything else runs on a
# disposable cluster. Dumps stay on the runner and are deleted at the end; only aggregates are printed.
set -uo pipefail
R=$(git rev-parse --show-toplevel); T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
PGBIN=/usr/lib/postgresql/17/bin
URL=$(cd "$R" && npx tsx -e 'import { resolveConnection } from "./scripts/lib/supabase-db"; const c = resolveConnection(); if (!c) { process.exit(3) } process.stdout.write(c.connectionString)') || { echo "FAIL no DB credential"; exit 1; }
PW=$(node -e 'const u=new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.password))' "$URL"); echo "::add-mask::$PW"; echo "::add-mask::$URL"
w=$(printf 'begin transaction read only;\ncreate temp table _probe(x int);\nrollback;\n' | "$PGBIN/psql" "$URL" -X -qAt 2>&1)
echo "$w" | grep -q "read-only transaction" && echo "PASS production session: write probe refused by the READ ONLY transaction" || { echo "FAIL write probe not refused: stop"; exit 1; }
"$PGBIN/pg_dump" "$URL" --schema-only --no-owner --no-comments -n public -f "$T/public.sql" 2>/dev/null || { echo "FAIL schema dump"; exit 1; }
# Minimal, redacted extraction (no pg_dump of data): ONLY the open operations, ONLY the columns the reconciliation rules
# and pi_supply_spend read. Keys and project ids become one-way pseudonyms; shot ids, models, provider job ids and result
# references are replaced by placeholders (only their presence is kept). No prompt, URL, user id or path is read.
cat > "$T/extract.sql" <<'SQL'
begin transaction read only;
\copy (select 'k-' || md5(idempotency_key), case when project_id like 'podcast-%' then 'podcast-' else 'p-' end || md5(project_id), 'redacted', provider, 'redacted', method, attempt_kind, reserved_usd, committed_usd, status, case when provider_job_id is null then null else 'redacted' end, case when result_ref is null then null else 'redacted' end, created_at, updated_at, supply_reconciled from public.pi_paid_operations where status in ('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')) to 'OPEN_CSV' csv
rollback;
SQL
sed -i "s#OPEN_CSV#$T/open.csv#" "$T/extract.sql"
"$PGBIN/psql" "$URL" -X -q -v ON_ERROR_STOP=1 -f "$T/extract.sql" >/dev/null 2>"$T/extract.err" || { echo "FAIL redacted extraction: $(sed "s/$PW/***/g" "$T/extract.err" | head -2)"; exit 1; }
printf "set session_replication_role = replica;\n\\copy public.pi_paid_operations (idempotency_key, project_id, shot_id, provider, model, method, attempt_kind, reserved_usd, committed_usd, status, provider_job_id, result_ref, created_at, updated_at, supply_reconciled) from '%s' csv\nset session_replication_role = origin;\n" "$T/open.csv" > "$T/data.sql"
# self-check of the redaction: no original key/project id may survive (pseudonyms are 'k-'/'p-'/'podcast-' + 32 hex)
python3 -I - "$T/open.csv" <<'PY' || { echo "FAIL redaction self-check"; exit 1; }
import csv, re, sys
rows = list(csv.reader(open(sys.argv[1])))
ok = all(re.fullmatch(r"k-[0-9a-f]{32}", r[0]) and re.fullmatch(r"(p|podcast)-[0-9a-f]{32}", r[1]) and r[2] == "redacted" and r[4] == "redacted"
         and r[10] in ("", "redacted") and r[11] in ("", "redacted") for r in rows)
print(f"PASS redacted extraction: {len(rows)} open operations, 15 columns, keys/projects pseudonymized, shot/model/job/result redacted" if ok else "FAIL redaction")
sys.exit(0 if ok else 1)
PY
echo "INFO production read: schema $(wc -l < "$T/public.sql") lines (structure only); data = $(wc -l < "$T/open.csv") redacted open rows; kept in a temp dir deleted on exit; nothing uploaded"
INT="$T/int"; git -C "$R" fetch -q --depth=1 origin d8b203d665e62602cec5cb72620f03b5630edd12 && git -C "$R" worktree add -q --detach "$INT" d8b203d665e62602cec5cb72620f03b5630edd12
PG_BIN=$PGBIN SCHEMA_SQL="$T/public.sql" DATA_SQL="$T/data.sql" INT="$INT" bash "$R/scripts/qa/conciliacion/run.sh" "$T/w" 55971
