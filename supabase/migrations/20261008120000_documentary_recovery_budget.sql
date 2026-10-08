-- Hard spend cap for recovering ONE documentary script job (first use: Bigfoot 03738404).
-- PREPARED FOR REVIEW. Not applied to production in this phase.
--
-- What it guarantees (enforced in the database, before any provider call):
--   new committed spend + new pending/uncertain reservations + this call's reservation <= cap_usd
-- * "New" = every ledger operation of the job's project EXCEPT baseline_keys (the operations that already
--   existed when the budget was opened: for Bigfoot, the five paid responses). Baseline ops never count.
-- * COMMITTED counts its committed cost; SUBMITTED / PROVIDER_JOB_RECORDED / RECONCILIATION_REQUIRED count
--   their full reservation (uncertain spend is never released here); REFUNDED and not-yet-admitted RESERVED
--   rows count 0 (a RESERVED row reaches the provider only through this same check).
-- * The budget row is locked FOR UPDATE before the sum, so two workers serialize: two reservations that each
--   fit but together exceed the cap can never both be admitted.
-- * Exact numeric arithmetic (no floating point).
-- * The budget is bound to the job and its owner, cannot be reset or raised (immutable), and survives retries,
--   worker restarts and double clicks (it is keyed by the job's ledger project, which retries do not change).
-- * Projects without a budget behave exactly as before: the original pi_submit_with_supply body is kept
--   unchanged as pi_submit_with_supply_core and every other check (supply, caps, concurrency, reconciliation)
--   still applies after this one.

create table if not exists public.pi_recovery_budgets (
  project_id text primary key,
  job_id uuid not null unique references public.documentary_script_jobs(id) on delete restrict,
  owner_id uuid not null,
  cap_usd numeric(12,6) not null check (cap_usd > 0 and cap_usd <= 25),
  baseline_keys text[] not null,
  authorization_ref text not null check (length(trim(authorization_ref)) > 0),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'CLOSED')),
  created_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  check (project_id like 'documentary:' || owner_id::text || ':%')
);
alter table public.pi_recovery_budgets enable row level security;
revoke all on public.pi_recovery_budgets from public, anon, authenticated;
grant select on public.pi_recovery_budgets to service_role;

-- Immutable: no reset, no raise, no re-baseline, no reopen, no delete. Only ACTIVE -> CLOSED.
create or replace function public.pi_recovery_budget_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'recovery budgets cannot be deleted'; end if;
  if new.project_id is distinct from old.project_id or new.job_id is distinct from old.job_id
     or new.owner_id is distinct from old.owner_id or new.cap_usd is distinct from old.cap_usd
     or new.baseline_keys is distinct from old.baseline_keys or new.authorization_ref is distinct from old.authorization_ref
     or new.created_at is distinct from old.created_at then
    raise exception 'recovery budget is immutable';
  end if;
  if old.status = 'CLOSED' and new.status <> 'CLOSED' then raise exception 'a closed recovery budget cannot be reopened'; end if;
  return new;
end $$;
drop trigger if exists pi_recovery_budget_guard on public.pi_recovery_budgets;
create trigger pi_recovery_budget_guard before update or delete on public.pi_recovery_budgets
  for each row execute function public.pi_recovery_budget_guard();

-- Spend of a budget (read-only; also used by the admission check). Exact numeric.
-- VOLATILE on purpose: a STABLE function would reuse the caller's snapshot and, after waiting for the budget lock,
-- miss an admission committed by a concurrent worker (verified with two real sessions).
create or replace function public.pi_recovery_budget_usage(p_project_id text, p_exclude_key text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare b public.pi_recovery_budgets%rowtype; committed_new numeric; pending_new numeric;
begin
  select * into b from public.pi_recovery_budgets where project_id = p_project_id;
  if not found then return null; end if;
  select coalesce(sum(coalesce(committed_usd, reserved_usd)) filter (where status = 'COMMITTED'), 0),
         coalesce(sum(reserved_usd) filter (where status in ('SUBMITTED', 'PROVIDER_JOB_RECORDED', 'RECONCILIATION_REQUIRED')), 0)
    into committed_new, pending_new
    from public.pi_paid_operations
   where project_id = p_project_id
     and idempotency_key is distinct from p_exclude_key
     and not (idempotency_key = any (b.baseline_keys));
  return jsonb_build_object('capUsd', b.cap_usd, 'committedUsd', committed_new, 'pendingUsd', pending_new,
    'remainingUsd', b.cap_usd - committed_new - pending_new, 'status', b.status, 'baselineOperations', cardinality(b.baseline_keys));
end $$;
revoke all on function public.pi_recovery_budget_usage(text, text) from public, anon, authenticated;
grant execute on function public.pi_recovery_budget_usage(text, text) to service_role;

-- Open (once) the budget of a failed documentary job. Idempotent: an existing budget is returned unchanged,
-- never reset or raised. The baseline is every ledger operation already in the project.
create or replace function public.pi_open_recovery_budget(p_job_id uuid, p_project_id text, p_cap_usd numeric, p_authorization_ref text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.documentary_script_jobs%rowtype; b public.pi_recovery_budgets%rowtype; keys text[];
begin
  select * into b from public.pi_recovery_budgets where job_id = p_job_id or project_id = p_project_id limit 1;
  if found then
    return jsonb_build_object('opened', false, 'reason', 'already_open', 'projectMatches', b.project_id = p_project_id,
      'capUsd', b.cap_usd, 'baselineOperations', cardinality(b.baseline_keys), 'status', b.status);
  end if;
  select * into j from public.documentary_script_jobs where id = p_job_id for update;
  if not found then return jsonb_build_object('opened', false, 'reason', 'job not found'); end if;
  if j.status <> 'failed' then return jsonb_build_object('opened', false, 'reason', 'job is not failed'); end if;
  if p_project_id not like 'documentary:' || j.user_id::text || ':%' then
    return jsonb_build_object('opened', false, 'reason', 'project does not belong to the job owner');
  end if;
  if exists (select 1 from public.pi_paid_operations where project_id = p_project_id
             and status in ('SUBMITTED', 'PROVIDER_JOB_RECORDED', 'RECONCILIATION_REQUIRED')) then
    return jsonb_build_object('opened', false, 'reason', 'uncertain operations must be reconciled first');
  end if;
  select coalesce(array_agg(idempotency_key order by idempotency_key), '{}') into keys
    from public.pi_paid_operations where project_id = p_project_id;
  insert into public.pi_recovery_budgets(project_id, job_id, owner_id, cap_usd, baseline_keys, authorization_ref)
  values (p_project_id, p_job_id, j.user_id, p_cap_usd, keys, p_authorization_ref);
  return jsonb_build_object('opened', true, 'capUsd', p_cap_usd, 'baselineOperations', cardinality(keys));
end $$;
revoke all on function public.pi_open_recovery_budget(uuid, text, numeric, text) from public, anon, authenticated, service_role;
-- Opening a budget is an operator action (authorized spend): execute is granted explicitly when it is authorized.

-- Keep the original admission body unchanged under a new name (once).
do $$ begin
  if to_regprocedure('public.pi_submit_with_supply_core(text,numeric)') is null then
    alter function public.pi_submit_with_supply(text, numeric) rename to pi_submit_with_supply_core;
  end if;
end $$;
revoke all on function public.pi_submit_with_supply_core(text, numeric) from public, anon, authenticated, service_role;

-- Same name and signature the application already calls. Budget first (locked), then the unchanged core.
create or replace function public.pi_submit_with_supply(p_key text, p_units numeric default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.pi_paid_operations%rowtype; b public.pi_recovery_budgets%rowtype; usage jsonb;
begin
  select * into o from public.pi_paid_operations where idempotency_key = p_key;
  if found and o.status = 'RESERVED' then
    select * into b from public.pi_recovery_budgets where project_id = o.project_id for update;
    if found then
      if b.status <> 'ACTIVE' then
        return jsonb_build_object('submitted', false, 'reason', 'recovery budget closed', 'capUsd', b.cap_usd);
      end if;
      -- Re-read under the lock: another worker may have admitted an operation while we waited.
      select * into o from public.pi_paid_operations where idempotency_key = p_key;
      if o.status <> 'RESERVED' then return jsonb_build_object('submitted', false, 'reason', 'already_claimed'); end if;
      if o.reserved_usd is null or o.reserved_usd <= 0 or o.reserved_usd = 'NaN'::numeric then
        return jsonb_build_object('submitted', false, 'reason', 'recovery budget: cost unverified');
      end if;
      usage := public.pi_recovery_budget_usage(o.project_id, p_key);
      if (usage->>'committedUsd')::numeric + (usage->>'pendingUsd')::numeric + o.reserved_usd > b.cap_usd then
        return jsonb_build_object('submitted', false, 'reason', 'recovery budget exceeded', 'capUsd', b.cap_usd,
          'committedUsd', usage->'committedUsd', 'pendingUsd', usage->'pendingUsd', 'requestedUsd', o.reserved_usd);
      end if;
    end if;
  end if;
  return public.pi_submit_with_supply_core(p_key, p_units);
end $$;
revoke all on function public.pi_submit_with_supply(text, numeric) from public, anon, authenticated;
grant execute on function public.pi_submit_with_supply(text, numeric) to service_role;
