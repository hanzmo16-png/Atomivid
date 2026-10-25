#!/usr/bin/env bash
# USD 0. Disposable PostgreSQL test of the open-operation reconciliation tool (docs/ops/conciliacion). Never touches any
# other database. Schema source: SCHEMA_SQL (production schema dump, CI) or the repo migrations of INT (local).
# Optional DATA_SQL (pi_* data dump, CI only): dry run of the default plan on a copy of the real open operations.
# Usage: bash scripts/qa/conciliacion/run.sh [workdir] [port]
set -uo pipefail
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel); W=${1:-$(mktemp -d)}; P=${2:-55961}
PB=${PG_BIN:-$( (pg_config --bindir 2>/dev/null) || ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}
TOOL="$R/docs/ops/conciliacion/pi_reconcile_open_operation.sql"; RB="$R/docs/ops/conciliacion/pi_reconcile_open_operation.rollback.sql"
fails=0; pass(){ echo "PASS $*"; }; fail(){ echo "FAIL $*"; fails=$((fails+1)); }
mkdir -p "$W/logs" "$W/run"
"$PB/initdb" -D "$W/pg" -U postgres --auth=trust >/dev/null
"$PB/pg_ctl" -D "$W/pg" -o "-p $P -k $W/run -c listen_addresses=''" -l "$W/logs/pg.log" -w start >/dev/null
trap '"$PB/pg_ctl" -D "$W/pg" -m fast stop >/dev/null 2>&1 || true' EXIT
Q="$PB/psql -h $W/run -p $P -U postgres -X -q"
$Q -d postgres -c "create database rec" >/dev/null
INT=${INT:-$R}
$Q -d rec -f "$INT/scripts/harness/e2e/infra/stubs.sql" >/dev/null 2>&1
$Q -d rec -c "create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions" >/dev/null 2>&1
if [ -n "${SCHEMA_SQL:-}" ]; then
  $Q -d rec -f "$SCHEMA_SQL" > "$W/logs/schema.log" 2>&1; echo "INFO schema source: production dump ($(grep -c ERROR "$W/logs/schema.log") restore errors, grants to absent Supabase roles included)"
else
  git -C "$R" cat-file -e 9dccd68c3b06bffab2dc91ab415de6c2a73062bd 2>/dev/null || git -C "$R" fetch -q origin 9dccd68c3b06bffab2dc91ab415de6c2a73062bd
  git -C "$R" show 9dccd68c3b06bffab2dc91ab415de6c2a73062bd:supabase/migrations/0023_production_intelligence.sql > "$W/run/0023.sql"
  echo "0b49d9a4752d19c1b6f6f24df6c3f0c6fbdbd39136a41832f5a6189aa7fa8131  $W/run/0023.sql" | sha256sum -c --quiet || { echo "FAIL 0023 checksum"; exit 1; }
  d23=0; for f in $(ls "$INT"/supabase/migrations/*.sql | sort); do b=$(basename "$f")
    if [ "$b" \> "0019_long_form_production_plan.sql" ] && [ $d23 = 0 ]; then $Q -d rec -f "$W/run/0023.sql" > /dev/null 2>&1; d23=1; fi
    $Q -d rec -f "$f" > "$W/logs/mig-$b.log" 2>&1 || echo "NOTICE local migration not applied: $b"; done
  echo "INFO schema source: repo migrations of $(git -C "$INT" rev-parse --short HEAD)"
fi
[ "$($Q -d rec -At -c "select to_regclass('public.pi_paid_operations') is not null and to_regprocedure('public.pi_supply_spend(text,timestamptz)') is not null")" = t ] || { echo "FAIL base schema lacks the ledger"; exit 1; }
if [ -n "${DATA_SQL:-}" ]; then $Q -d rec -f "$DATA_SQL" > "$W/logs/data.log" 2>&1; echo "INFO real pi_* data restored ($(grep -c ERROR "$W/logs/data.log") errors)"; fi
sha=$(sha256sum "$TOOL" | cut -d' ' -f1); echo "INFO tool sha256 $sha"
grep -q "  docs/ops/conciliacion/pi_reconcile_open_operation.sql$" "$R/docs/ops/conciliacion/SHA256SUMS" 2>/dev/null && (cd "$R" && sha256sum -c --quiet docs/ops/conciliacion/SHA256SUMS) && pass "tool files match docs/ops/conciliacion/SHA256SUMS" || fail "tool files do not match SHA256SUMS"
$Q -d rec -v ON_ERROR_STOP=1 -f "$TOOL" > "$W/logs/tool.log" 2>&1 && pass "tool applies" || { fail "tool does not apply: $(grep -m2 ERROR "$W/logs/tool.log")"; echo "RESULT conciliacion: $fails FAIL"; exit 1; }
$Q -d rec -v ON_ERROR_STOP=1 -f "$TOOL" > /dev/null 2>&1 && pass "tool re-applies (idempotent definition)" || fail "tool re-apply"
# an incompatible pre-existing log table must not be accepted silently by IF NOT EXISTS: the WHOLE contract is compared
# (CORRECCION-1). Each case starts from a copy of the correctly installed database, alters only the log table, re-applies
# the tool and must see it abort with 'incompatible' and leave the altered table exactly as it was (transaction rolled back).
BARE="drop table public.pi_reconciliation_log cascade; create table public.pi_reconciliation_log (decision_id text, idempotency_key text,
  decision_sha256 text, outcome text, evidence text, amount_usd numeric(12,4), before_row jsonb, after_row jsonb, actor text, decided_at timestamptz)"
L=public.pi_reconciliation_log
inc_case() { # name, SQL that alters the log table
  $Q -d postgres -c "drop database if exists inc" >/dev/null 2>&1; $Q -d postgres -c "create database inc template rec" >/dev/null 2>&1
  $Q -d inc -v ON_ERROR_STOP=1 -c "$2" > "$W/logs/inc-setup.log" 2>&1 || { fail "incompatible case '$1': setup failed $(grep -m1 ERROR "$W/logs/inc-setup.log")"; return; }
  local before; before=$($Q -d inc -At -c "select md5(string_agg(p, ',' order by p)) from (select a.attname||format_type(a.atttypid,a.atttypmod)||a.attnotnull p from pg_attribute a where a.attrelid='$L'::regclass and a.attnum>0 and not a.attisdropped union all select contype::text||pg_get_constraintdef(oid) from pg_constraint where conrelid='$L'::regclass union all select tgname from pg_trigger where tgrelid='$L'::regclass and not tgisinternal) x")
  if $Q -d inc -v ON_ERROR_STOP=1 -f "$TOOL" > "$W/logs/inc.log" 2>&1; then fail "tool accepted a pre-existing pi_reconciliation_log with $1"; return; fi
  local after; after=$($Q -d inc -At -c "select md5(string_agg(p, ',' order by p)) from (select a.attname||format_type(a.atttypid,a.atttypmod)||a.attnotnull p from pg_attribute a where a.attrelid='$L'::regclass and a.attnum>0 and not a.attisdropped union all select contype::text||pg_get_constraintdef(oid) from pg_constraint where conrelid='$L'::regclass union all select tgname from pg_trigger where tgrelid='$L'::regclass and not tgisinternal) x")
  # the fingerprint must be a real md5 (an empty value would make "nothing changed" vacuous)
  grep -q 'incompatible' "$W/logs/inc.log" && [[ "$before" =~ ^[0-9a-f]{32}$ ]] && [ "$before" = "$after" ] && pass "tool refuses a pre-existing pi_reconciliation_log with $1 (fail closed, nothing changed)" \
    || fail "incompatible case '$1': unexpected outcome $(grep -m1 ERROR "$W/logs/inc.log") before=$before after=$after"
}
inc_case "different columns" "drop table $L cascade; create table $L (decision_id text primary key, note text)"
inc_case "the same columns and types but no PK/UNIQUE/FK/CHECK/NOT NULL/defaults" "$BARE"
inc_case "the same columns, constraints restored but no defaults" "$BARE; alter table $L add primary key (decision_id), add unique (idempotency_key), add foreign key (idempotency_key) references public.pi_paid_operations (idempotency_key)"
inc_case "UNIQUE (idempotency_key) dropped" "alter table $L drop constraint pi_reconciliation_log_idempotency_key_key"
inc_case "PRIMARY KEY replaced by a plain index" "alter table $L drop constraint pi_reconciliation_log_pkey; create index on $L (decision_id)"
inc_case "the FK dropped" "alter table $L drop constraint pi_reconciliation_log_idempotency_key_fkey"
inc_case "a mutated outcome CHECK (accepts 'refund')" "alter table $L drop constraint pi_reconciliation_log_outcome_check, add constraint pi_reconciliation_log_outcome_check check (outcome in ('cancelled_before_submission','not_charged','charged','assumed_charged','refund'))"
inc_case "the amount CHECK marked NOT VALID" "alter table $L drop constraint pi_reconciliation_log_amount_usd_check, add constraint pi_reconciliation_log_amount_usd_check check (amount_usd >= 0) not valid"
inc_case "a changed actor default" "alter table $L alter column actor set default 'tool'"
inc_case "NOT NULL dropped on evidence" "alter table $L alter column evidence drop not null"
inc_case "a deferrable UNIQUE" "alter table $L drop constraint pi_reconciliation_log_idempotency_key_key, add constraint pi_reconciliation_log_idempotency_key_key unique (idempotency_key) deferrable initially deferred"
inc_case "an extra user trigger" "create function public.inc_t() returns trigger language plpgsql as \$\$ begin return null; end \$\$; create trigger inc_skip before insert on $L for each row execute function public.inc_t()"
inc_case "a rewrite rule" "create rule inc_rule as on insert to $L do instead nothing"
inc_case "a view in its place" "drop table $L cascade; create view $L as select 'x'::text decision_id, 'x'::text idempotency_key, 'x'::text decision_sha256, 'x'::text outcome, 'x'::text evidence, 0::numeric(12,4) amount_usd, '{}'::jsonb before_row, '{}'::jsonb after_row, 'x'::text actor, now() decided_at"
# GREEN: the correct definition re-applies (idempotent) and the contract helper does not survive the install
$Q -d postgres -c "drop database if exists inc" >/dev/null 2>&1; $Q -d postgres -c "create database inc template rec" >/dev/null 2>&1
$Q -d inc -v ON_ERROR_STOP=1 -f "$TOOL" > "$W/logs/inc.log" 2>&1 && [ "$($Q -d inc -At -c "select to_regprocedure('public.pi_reconciliation_contract_parts(regclass)') is null and to_regnamespace('pi_reconcile_contract_ref') is null")" = t ] \
  && pass "the correct pre-existing definition re-applies; no contract helper or reference table is left behind" || fail "correct definition re-apply: $(grep -m1 ERROR "$W/logs/inc.log")"
$Q -d postgres -c "drop database if exists inc" >/dev/null 2>&1

# ---- dry run of the default plan on the real open operations (copy) BEFORE the synthetic tests touch anything ----
if [ -n "${DATA_SQL:-}" ]; then
  $Q -d rec -At -v ON_ERROR_STOP=0 > "$W/logs/dry.txt" 2>&1 <<'SQL'
create temp table before as select provider, public.pi_supply_spend(provider, date_trunc('month', now())) m from (select distinct provider from public.pi_paid_operations) x;
create temp table plan as select idempotency_key k, status st, updated_at u, provider, reserved_usd r,
  case when status = 'RESERVED' and provider_job_id is null and result_ref is null then 'cancelled_before_submission'
       when status = 'SUBMITTED' and provider = 'internal' then 'not_charged'
       when status in ('RECONCILIATION_REQUIRED','SUBMITTED','PROVIDER_JOB_RECORDED') then 'assumed_charged' else 'manual' end outcome
  from public.pi_paid_operations where status in ('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED');
select 'DRY plan', st, outcome, count(*), sum(r) from plan group by 2, 3 order by 2, 3;
do $$ declare p record; ok int := 0; bad int := 0; m text; begin
  for p in select * from plan where outcome <> 'manual' order by k loop
    begin perform public.pi_reconcile_open_operation('dry-' || md5(p.k), p.k, p.st, p.u, p.outcome,
        case p.outcome when 'cancelled_before_submission' then 'dry run: never submitted' when 'not_charged' then 'dry run: internal provider' else 'dry run: no proof of non-charge' end);
      ok := ok + 1;
    exception when others then bad := bad + 1; m := sqlerrm; raise notice 'DRY refused: %', m; end;
  end loop;
  raise notice 'DRY applied % refused %', ok, bad; end $$;
select 'DRY open after', count(*) from public.pi_paid_operations where status in ('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED');
select 'DRY month spend delta', b.provider, b.m, public.pi_supply_spend(b.provider, date_trunc('month', now())) - b.m from before b
  where public.pi_supply_spend(b.provider, date_trunc('month', now())) <> b.m order by 2;
select 'DRY log rows', count(*), sum(amount_usd) from public.pi_reconciliation_log;
SQL
  grep -E '^DRY|NOTICE' "$W/logs/dry.txt" | sed 's/^psql:[^ ]* NOTICE:  /NOTICE /'
  grep -q 'DRY applied' "$W/logs/dry.txt" && pass "dry run on the copied real open operations completed (see DRY lines)" || fail "dry run did not complete"
  # a fresh cluster state for the synthetic tests: drop the dry-run decisions by recreating the database from scratch
  $Q -d postgres -c "drop database rec" -c "create database rec" >/dev/null
  $Q -d rec -f "$INT/scripts/harness/e2e/infra/stubs.sql" >/dev/null 2>&1
  $Q -d rec -c "create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions" >/dev/null 2>&1
  $Q -d rec -f "$SCHEMA_SQL" > /dev/null 2>&1; $Q -d rec -v ON_ERROR_STOP=1 -f "$TOOL" > /dev/null 2>&1
fi

# ---- synthetic assertions ----
$Q -d rec -At -f "$R/scripts/qa/conciliacion/test.sql" > "$W/logs/test.txt" 2>&1; cat "$W/logs/test.txt" | grep -E '^(PASS|FAIL)|ERROR'
fails=$((fails + $(grep -c '^FAIL' "$W/logs/test.txt") + $(grep -c 'ERROR' "$W/logs/test.txt")))

# ---- rollback: an aborted batch leaves nothing behind ----
$Q -d rec -At > "$W/logs/rb.txt" 2>&1 <<'SQL'
begin;
select public.pi_reconcile_open_operation('dec-rb-0010', 'qa-r10', 'RECONCILIATION_REQUIRED', (select updated_at from public.pi_paid_operations where idempotency_key = 'qa-r10'), 'assumed_charged', 'batch item 1');
select 1/0; -- a later item of the same batch fails
commit;
SQL
[ "$($Q -d rec -At -c "select status = 'RECONCILIATION_REQUIRED' and not exists (select 1 from public.pi_reconciliation_log where idempotency_key = 'qa-r10') from public.pi_paid_operations where idempotency_key = 'qa-r10'")" = t ] \
  && pass "rollback: an aborted batch leaves the operation and the log untouched" || fail "rollback left changes"

# ---- concurrency: two operators reconcile the same operation at once → exactly one decision wins ----
U=$($Q -d rec -At -c "select updated_at from public.pi_paid_operations where idempotency_key = 'qa-r9'")
( $Q -d rec -At -c "begin; select public.pi_reconcile_open_operation('dec-conc-0001', 'qa-r9', 'RECONCILIATION_REQUIRED', '$U', 'assumed_charged', 'operator A'); select pg_sleep(3); commit;" > "$W/logs/c1.txt" 2>&1 ) &
sleep 1
$Q -d rec -At -c "select public.pi_reconcile_open_operation('dec-conc-0002', 'qa-r9', 'RECONCILIATION_REQUIRED', '$U', 'not_charged', 'operator B')" > "$W/logs/c2.txt" 2>&1
wait
grep -q '"status": "COMMITTED"' "$W/logs/c1.txt" && grep -qE 'already reconciled|changed since the plan' "$W/logs/c2.txt" \
  && [ "$($Q -d rec -At -c "select count(*) from public.pi_reconciliation_log where idempotency_key = 'qa-r9'")" = 1 ] \
  && pass "concurrency: the second operator waits, then is refused; one decision, one log row" || { fail "concurrency"; cat "$W/logs/c1.txt" "$W/logs/c2.txt"; }

# ---- rollback of the tool itself ----
$Q -d rec -v ON_ERROR_STOP=1 -f "$RB" > "$W/logs/rb1.txt" 2>&1 && fail "tool rollback ran although decisions exist" || { grep -q 'ROLLBACK refused' "$W/logs/rb1.txt" && pass "tool rollback refuses while decisions exist (audit trail kept)" || fail "tool rollback error: $(head -2 "$W/logs/rb1.txt")"; }
$Q -d postgres -c "create database rec2 template rec" >/dev/null 2>&1 || true
$Q -d postgres -c "drop database if exists rec3" -c "create database rec3" >/dev/null
$Q -d rec3 -f "$INT/scripts/harness/e2e/infra/stubs.sql" >/dev/null 2>&1
if [ -n "${SCHEMA_SQL:-}" ]; then $Q -d rec3 -f "$SCHEMA_SQL" >/dev/null 2>&1; else $Q -d rec3 -f "$W/run/0023.sql" >/dev/null 2>&1; for f in $(ls "$INT"/supabase/migrations/*.sql | sort); do $Q -d rec3 -f "$f" >/dev/null 2>&1; done; fi
$Q -d rec3 -v ON_ERROR_STOP=1 -f "$TOOL" >/dev/null 2>&1 && $Q -d rec3 -v ON_ERROR_STOP=1 -f "$RB" >/dev/null 2>&1 \
  && [ "$($Q -d rec3 -At -c "select to_regclass('public.pi_reconciliation_log') is null and to_regprocedure('public.pi_reconcile_open_operation(text,text,text,timestamptz,text,text,numeric,boolean)') is null")" = t ] \
  && pass "tool rollback on an unused install removes it completely" || fail "tool rollback on an unused install"
echo "RESULT conciliacion: $fails FAIL"
[ $fails = 0 ]
