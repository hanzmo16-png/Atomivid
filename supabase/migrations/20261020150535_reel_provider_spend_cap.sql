-- Prepared only. Apply before the application change; no production execution in this delivery.
-- One total PROVIDER cap, across script + voice + images + music and ALL attempts.
-- Job supply reservations are capacity envelopes, not charges, and do not count twice.
set local lock_timeout = '3s';

alter table public.video_requests add column provider_spend_cap_usd numeric(12,4);
alter table public.video_requests add constraint video_requests_provider_spend_cap
  check (provider_spend_cap_usd is null or
    (mode = 'visual' and provider_spend_cap_usd > 0 and provider_spend_cap_usd <= 25
     and provider_spend_cap_usd::text not in ('NaN','Infinity','-Infinity')));

-- Set once, at INSERT, before any script is paid. Never reset or raise on retry, even by service_role.
create or replace function public.pi_reel_budget_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.provider_spend_cap_usd is not null then raise exception 'capped reel cannot be deleted'; end if;
    return old;
  end if;
  if new.provider_spend_cap_usd is distinct from old.provider_spend_cap_usd then
    raise exception 'reel provider budget is immutable';
  end if;
  if old.provider_spend_cap_usd is not null and new.id is distinct from old.id then
    raise exception 'capped reel identity is immutable';
  end if;
  return new;
end $$;
revoke all on function public.pi_reel_budget_immutable() from public, anon, authenticated;
create trigger pi_reel_budget_immutable before update or delete on public.video_requests
for each row execute function public.pi_reel_budget_immutable();

-- Keep the documentary budget logic and the original core. No new externally callable RPC.
create or replace function public.pi_submit_with_supply(p_key text, p_units numeric default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare o public.pi_paid_operations%rowtype; b public.pi_recovery_budgets%rowtype; usage jsonb;
  cap numeric; committed numeric; pending numeric;
begin
  select * into o from public.pi_paid_operations where idempotency_key = p_key;
  if found and o.status = 'RESERVED' then
    -- Only UUID projects can be a Reel; cast the key, not the indexed request column.
    if o.project_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      select provider_spend_cap_usd into cap from public.video_requests where id = o.project_id::uuid;
      if cap is not null then
        -- SAME order as pi_reserve_job_supply: global policy, then request. Reversing it deadlocks
        -- an admission racing the reservation of another attempt of this same request.
        perform 1 from public.pi_supply_policies where provider = '__global__' for update;
        select provider_spend_cap_usd into cap from public.video_requests where id = o.project_id::uuid for update;
        select * into o from public.pi_paid_operations where idempotency_key = p_key;
        if o.status <> 'RESERVED' then return jsonb_build_object('submitted', false, 'reason', 'already_claimed'); end if;
        if o.reserved_usd is null or o.reserved_usd <= 0 or o.reserved_usd::text in ('NaN','Infinity','-Infinity') then
          return jsonb_build_object('submitted', false, 'reason', 'reel budget: cost unverified', 'capUsd', cap);
        end if;
        -- VOLATILE, fresh statement AFTER the lock: see admissions committed while this caller waited.
        -- Uncertain refunds still count; a genuine, reconciled zero-cost rejection can release capacity.
        select coalesce(sum(coalesce(committed_usd, reserved_usd)) filter (where status = 'COMMITTED'), 0),
          coalesce(sum(reserved_usd) filter (where status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
            or (status = 'REFUNDED' and not coalesce(supply_reconciled, false))), 0)
          into committed, pending from public.pi_paid_operations
          where project_id = o.project_id and idempotency_key <> p_key and method <> 'capacity_hold';
        if committed + pending + o.reserved_usd > cap then
          return jsonb_build_object('submitted', false, 'reason', 'reel budget exceeded', 'capUsd', cap,
            'committedUsd', committed, 'pendingUsd', pending, 'requestedUsd', o.reserved_usd);
        end if;
      end if;
    end if;

    -- Existing documentary recovery budget, unchanged.
    select * into b from public.pi_recovery_budgets where project_id = o.project_id for update;
    if found then
      if b.status <> 'ACTIVE' then
        return jsonb_build_object('submitted', false, 'reason', 'recovery budget closed', 'capUsd', b.cap_usd);
      end if;
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
