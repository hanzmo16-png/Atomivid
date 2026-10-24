-- Rollback: restores pi_open_spend_authorization exactly as in 20261024000000_spend_authorizations.sql (baseline includes RESERVED).
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
  select coalesce(array_agg(idempotency_key order by idempotency_key), '{}') into keys from public.pi_paid_operations where project_id = pid;
  insert into public.pi_spend_authorizations(project_id, owner_id, cap_usd, authorization_ref, baseline_keys) values (pid, e.user_id, p_cap_usd, p_authorization_ref, keys);
  return jsonb_build_object('opened', true, 'projectId', pid, 'capUsd', p_cap_usd, 'baselineOperations', cardinality(keys));
end $$;

revoke all on function public.pi_open_spend_authorization(uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.pi_open_spend_authorization(uuid, numeric, text) to service_role;
commit;
