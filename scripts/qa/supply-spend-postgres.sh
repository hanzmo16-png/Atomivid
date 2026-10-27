#!/usr/bin/env bash
# USD 0. Run by spend-authorization-db.sh against a DISPOSABLE cluster (PGHOST/PGPORT/DB). Real case 2026-10-27:
# Anthropic COMMITTED calls reserved at their upper bound but committed at their real cost, plus a USD 0.1706
# RESERVED hold that never reached the provider. Checks pi_supply_spend before/after the proposal and the rollback.
set -euo pipefail
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
Q="psql -h $PGHOST -p $PGPORT -U postgres -d $DB -v ON_ERROR_STOP=1 -qtA"
fails=0; ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fails=$((fails+1)); }
eq() { if [ "$1" = "$2" ]; then ok "$3 ($1)"; else bad "$3 (got $1, want $2)"; fi; }
op() { $Q -c "insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,committed_usd,status,supply_reconciled,created_at)
 values ('$1','documentary:p','script:$1','anthropic','m','generate_script','initial',$2,${3:-null},'$4',${5:-false},now())" >/dev/null; }
spend() { $Q -c "select round(public.pi_supply_spend('anthropic', now() - interval '1 day'),4)"; }
op c1 4.09 0.0508 COMMITTED
op c2 0.2289 0.134 COMMITTED
op r1 0.1706 "" RESERVED
eq "$(spend)" "4.3189" "S01 original: COMMITTED rows count their whole reservation (4.09 + 0.2289), RESERVED not counted"
$Q -f "$R/supabase/proposals/20261028100000_pi_supply_spend_committed.sql" >/dev/null
eq "$(spend)" "0.1848" "S02 proposal: COMMITTED rows count what they cost (0.0508 + 0.134)"
# Stale RESERVED released by the app (releaseStaleReservations): REFUNDED, committed 0, reconciled → not spend.
$Q -c "update public.pi_paid_operations set status='REFUNDED',committed_usd=0,supply_reconciled=true where idempotency_key='r1'" >/dev/null
eq "$(spend)" "0.1848" "S03 released never-submitted hold (supply_reconciled) is not counted"
# Same release WITHOUT the reconciled flag (code before this PR) → still counted as the full 0.1706.
op r2 0.1706 "" RESERVED
$Q -c "update public.pi_paid_operations set status='REFUNDED',committed_usd=0,supply_reconciled=false where idempotency_key='r2'" >/dev/null
eq "$(spend)" "0.3554" "S04 unreconciled refund keeps counting its reservation (why the release must reconcile)"
op u1 0.5 "" SUBMITTED
eq "$(spend)" "0.8554" "S05 in-flight SUBMITTED still counts its full reservation (conservative)"
op k1 0.3 "" COMMITTED
eq "$(spend)" "1.1554" "S06 COMMITTED with unknown cost falls back to its reservation"
eq "$($Q -c "select has_function_privilege('anon','public.pi_supply_spend(text,timestamptz)','execute')")" "f" "S07 grants preserved: anon cannot execute"
$Q -f "$R/supabase/proposals/20261028100000_pi_supply_spend_committed.rollback.sql" >/dev/null
eq "$(spend)" "5.2895" "S08 rollback restores the original arithmetic (4.09 + 0.2289 + 0.1706 unreconciled + 0.5 + 0.3)"
echo "RESULT supply-spend-postgres: $fails FAIL"; exit $fails
