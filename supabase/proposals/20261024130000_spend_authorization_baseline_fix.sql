-- PROPOSAL (NOT APPLIED). Follow-up of 20261024000000_spend_authorizations.sql (ALREADY APPLIED in production; never edited).
-- Closure audit #200: baseline_keys captured operations still in RESERVED (e.g. the reservation left by a call refused with
-- 'authorization missing'). Such a reservation is submitted LATER and, being in the baseline, was never counted against the cap.
-- Fix: the baseline only includes operations that are no longer RESERVED. Same signature, SECURITY DEFINER, search_path '',
-- service_role only. Idempotent (create or replace). Rollback: 20261024130000_spend_authorization_baseline_fix.rollback.sql.
-- Requires 20261024000000 applied first. Existing authorizations are not modified (immutable by trigger).
begin;
create or replace function public.pi_open_spend_authorization(p_episode_id uuid, p_cap_usd numeric, p_authorization_ref text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.podcast_episodes%rowtype; pid text := 'podcast-' || p_episode_id::text; keys text[];
begin
  if p_authorization_ref is null or length(trim(p_authorization_ref)) = 0 then raise exception 'authorization_ref required'; end if;
  select * into e from public.podcast_episodes where id = p_episode_id for update;
  if not found then return jsonb_build_object('opened', false, 'reason', 'episode not found'); end if;
  if exists (select 1 from public.pi_spend_authorizations where project_id = pid) then return jsonb_build_object('opened', false, 'reason', 'already_open'); end if;
  if exists (select 1 from public.pi_paid_operations where project_id = pid and status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')) then
    return jsonb_build_object('opened', false, 'reason', 'uncertain operations must be reconciled first'); end if;
  select coalesce(array_agg(idempotency_key order by idempotency_key), '{}') into keys from public.pi_paid_operations where project_id = pid and status <> 'RESERVED';
  insert into public.pi_spend_authorizations(project_id, owner_id, cap_usd, authorization_ref, baseline_keys) values (pid, e.user_id, p_cap_usd, p_authorization_ref, keys);
  return jsonb_build_object('opened', true, 'projectId', pid, 'capUsd', p_cap_usd, 'baselineOperations', cardinality(keys));
end $$;

revoke all on function public.pi_open_spend_authorization(uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.pi_open_spend_authorization(uuid, numeric, text) to service_role;
commit;
