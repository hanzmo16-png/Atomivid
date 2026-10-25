-- PROPOSAL (NOT APPLIED). Operator-only reconciliation of OPEN paid operations (pi_paid_operations) with provider evidence.
-- Not a migration; nothing applies this automatically. Applying it in production needs the owner's explicit authorization.
--
-- Why: 41 open operations (RESERVED / SUBMITTED / RECONCILIATION_REQUIRED) have no reviewed way to be closed. Hand-written
-- UPDATEs would bypass every rule below. The forward-only trigger already forbids moving a final row; this adds:
--   * one decision per operation, identified by decision_id (idempotent replay; a decision_id can never be reused);
--   * compare-and-set on (status, updated_at) captured in the plan: a row that changed since the plan is refused;
--   * rows touched in the last 24 h are refused (a live owner may still settle them);
--   * outcome rules by status — RESERVED never reached the provider (the engine writes SUBMITTED before any HTTP request),
--     so it can only be "cancelled_before_submission" and can never be charged; SUBMITTED/PROVIDER_JOB_RECORDED/
--     RECONCILIATION_REQUIRED left the process and may have been charged, so they need provider evidence:
--     "not_charged" (proof) → REFUNDED 0, "charged" (provider amount) → COMMITTED, "assumed_charged" (no way to prove the
--     opposite) → COMMITTED at the reserved amount (conservative);
--   * supply_reconciled = true on every REFUNDED outcome, so a released/never-charged reservation stops counting in
--     pi_supply_spend (REFUNDED with supply_reconciled = false counts its reserved_usd in the period: a naive release
--     would ADD spend);
--   * an append-only audit log with the row before/after, the evidence and the actor;
--   * EXECUTE only for the owner (postgres): neither the app (service_role) nor clients can call it.
begin;

create table if not exists public.pi_reconciliation_log (
  decision_id text primary key check (length(trim(decision_id)) >= 8),
  idempotency_key text not null unique references public.pi_paid_operations (idempotency_key),
  decision_sha256 text not null check (decision_sha256 ~ '^[0-9a-f]{64}$'),
  outcome text not null check (outcome in ('cancelled_before_submission', 'not_charged', 'charged', 'assumed_charged')),
  evidence text not null check (length(trim(evidence)) > 0),
  amount_usd numeric(12,4) not null check (amount_usd >= 0),
  before_row jsonb not null,
  after_row jsonb not null,
  actor text not null default current_user,
  decided_at timestamptz not null default clock_timestamp()
);
-- IF NOT EXISTS must never accept a different table silently: the exact column contract is checked.
do $$ begin
  if (select array_agg(column_name::text || ':' || data_type order by ordinal_position) from information_schema.columns
      where table_schema = 'public' and table_name = 'pi_reconciliation_log')
     is distinct from array['decision_id:text', 'idempotency_key:text', 'decision_sha256:text', 'outcome:text', 'evidence:text', 'amount_usd:numeric',
                            'before_row:jsonb', 'after_row:jsonb', 'actor:text', 'decided_at:timestamp with time zone'] then
    raise exception 'pi_reconciliation_log exists with an incompatible definition; refusing to install over it' using errcode = 'P0001';
  end if;
end $$;
alter table public.pi_reconciliation_log enable row level security;
revoke all on table public.pi_reconciliation_log from public, anon, authenticated, service_role;

create or replace function public.pi_reconciliation_log_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'pi_reconciliation_log is append-only (% rejected)', tg_op using errcode = 'P0001';
end $$;
drop trigger if exists pi_reconciliation_log_append_only on public.pi_reconciliation_log;
create trigger pi_reconciliation_log_append_only before update or delete on public.pi_reconciliation_log
  for each row execute function public.pi_reconciliation_log_immutable();
drop trigger if exists pi_reconciliation_log_no_truncate on public.pi_reconciliation_log;
create trigger pi_reconciliation_log_no_truncate before truncate on public.pi_reconciliation_log
  for each statement execute function public.pi_reconciliation_log_immutable();

create or replace function public.pi_reconcile_open_operation(
  p_decision_id text, p_key text, p_expected_status text, p_expected_updated_at timestamptz,
  p_outcome text, p_evidence text, p_actual_usd numeric default null, p_allow_over_reserved boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  o public.pi_paid_operations%rowtype;
  a public.pi_paid_operations%rowtype;
  prev public.pi_reconciliation_log%rowtype;
  amount numeric;
  n int;
  h text;
begin
  if p_decision_id is null or length(trim(p_decision_id)) < 8 then raise exception 'RECONCILE: decision_id required (>= 8 chars)' using errcode = 'P0001'; end if;
  -- Serialize every decision on the same operation (also covers the not-yet-logged race between two decision ids).
  perform pg_advisory_xact_lock(hashtext('pi_reconcile:' || coalesce(p_key, '')));
  -- Canonical hash of the WHOLE decision (amount normalized to the ledger scale, timestamp to UTC microseconds).
  h := encode(sha256(convert_to(jsonb_build_array(p_decision_id, p_key, p_expected_status,
         to_char(p_expected_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), p_outcome, p_evidence,
         (p_actual_usd::numeric(12,4))::text, coalesce(p_allow_over_reserved, false))::text, 'UTF8')), 'hex');
  select * into prev from public.pi_reconciliation_log where decision_id = p_decision_id;
  if found then
    if prev.decision_sha256 is distinct from h then
      raise exception 'RECONCILE: decision % replayed with different parameters (operation, preconditions, outcome, evidence, amount or override)', p_decision_id using errcode = 'P0001';
    end if;
    return jsonb_build_object('replayed', true, 'status', prev.after_row->>'status', 'amountUsd', prev.amount_usd, 'decisionSha256', h);
  end if;
  if p_evidence is null or length(trim(p_evidence)) = 0 then raise exception 'RECONCILE: provider evidence required' using errcode = 'P0001'; end if;
  select * into o from public.pi_paid_operations where idempotency_key = p_key for update;
  if not found then raise exception 'RECONCILE: operation not found' using errcode = 'P0001'; end if;
  if exists (select 1 from public.pi_reconciliation_log where idempotency_key = p_key) then
    raise exception 'RECONCILE: operation already reconciled by another decision' using errcode = 'P0001';
  end if;
  if o.status is distinct from p_expected_status or o.updated_at is distinct from p_expected_updated_at then
    raise exception 'RECONCILE: operation changed since the plan (now %, updated %)', o.status, o.updated_at using errcode = 'P0001';
  end if;
  if o.status not in ('RESERVED', 'SUBMITTED', 'PROVIDER_JOB_RECORDED', 'RECONCILIATION_REQUIRED') then
    raise exception 'RECONCILE: operation is not open (%)', o.status using errcode = 'P0001';
  end if;
  if o.updated_at > clock_timestamp() - interval '24 hours' then
    raise exception 'RECONCILE: operation touched in the last 24 h; it may still be owned by a live process' using errcode = 'P0001';
  end if;

  if p_outcome = 'cancelled_before_submission' then
    if o.status <> 'RESERVED' then raise exception 'RECONCILE: only a RESERVED row can be cancelled before submission (row is %)', o.status using errcode = 'P0001'; end if;
    if o.provider_job_id is not null or o.result_ref is not null then raise exception 'RECONCILE: RESERVED row carries provider data; reconcile it manually' using errcode = 'P0001'; end if;
    if coalesce(p_actual_usd, 0) <> 0 then raise exception 'RECONCILE: a never-submitted operation has no cost' using errcode = 'P0001'; end if;
    amount := 0;
    update public.pi_paid_operations set status = 'REFUNDED', committed_usd = 0, supply_reconciled = true,
      result_ref = 'cancelled-before-submission:' || p_decision_id
      where idempotency_key = p_key and status = o.status;
  elsif p_outcome = 'not_charged' then
    if o.status = 'RESERVED' then raise exception 'RECONCILE: a RESERVED row was never sent; use cancelled_before_submission' using errcode = 'P0001'; end if;
    if coalesce(p_actual_usd, 0) <> 0 then raise exception 'RECONCILE: not_charged has no amount' using errcode = 'P0001'; end if;
    amount := 0;
    update public.pi_paid_operations set status = 'REFUNDED', committed_usd = 0, supply_reconciled = true,
      result_ref = 'reconciled:not_charged:' || left(p_evidence, 200)
      where idempotency_key = p_key and status = o.status;
  elsif p_outcome in ('charged', 'assumed_charged') then
    if o.status = 'RESERVED' then raise exception 'RECONCILE: a RESERVED row was never sent to the provider; it cannot be charged' using errcode = 'P0001'; end if;
    if p_outcome = 'assumed_charged' then
      if p_actual_usd is not null then raise exception 'RECONCILE: assumed_charged books the reserved amount; do not pass one' using errcode = 'P0001'; end if;
      amount := o.reserved_usd;
    else
      amount := p_actual_usd;
      if amount is null or amount < 0 then raise exception 'RECONCILE: charged needs the provider amount (>= 0)' using errcode = 'P0001'; end if;
      if amount > o.reserved_usd and not coalesce(p_allow_over_reserved, false) then
        raise exception 'RECONCILE: provider amount % exceeds the reservation %; needs p_allow_over_reserved', amount, o.reserved_usd using errcode = 'P0001';
      end if;
    end if;
    update public.pi_paid_operations set status = 'COMMITTED', committed_usd = amount,
      result_ref = 'reconciled:' || p_outcome || ':' || left(p_evidence, 200)
      where idempotency_key = p_key and status = o.status;
  else
    raise exception 'RECONCILE: unknown outcome %', p_outcome using errcode = 'P0001';
  end if;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'RECONCILE: operation changed during reconciliation' using errcode = 'P0001'; end if;
  select * into a from public.pi_paid_operations where idempotency_key = p_key;
  insert into public.pi_reconciliation_log (decision_id, idempotency_key, decision_sha256, outcome, evidence, amount_usd, before_row, after_row)
    values (p_decision_id, p_key, h, p_outcome, p_evidence, amount, to_jsonb(o), to_jsonb(a));
  return jsonb_build_object('replayed', false, 'status', a.status, 'amountUsd', amount, 'decisionSha256', h);
end $$;
alter function public.pi_reconcile_open_operation(text, text, text, timestamptz, text, text, numeric, boolean) owner to postgres;
revoke all on function public.pi_reconcile_open_operation(text, text, text, timestamptz, text, text, numeric, boolean) from public, anon, authenticated, service_role;
revoke all on function public.pi_reconciliation_log_immutable() from public, anon, authenticated, service_role;

commit;
