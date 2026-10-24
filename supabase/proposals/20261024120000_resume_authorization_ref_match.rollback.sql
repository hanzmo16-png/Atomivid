-- Rollback of PROPOSAL 20261024120000_resume_authorization_ref_match.sql: restores the exact PR198 (762714e) bodies
-- and ACLs from 20261024000000_spend_authorizations.sql. WARNING: this re-opens the A/B bypass (T10c). Re-runnable.
begin;
create or replace function public.pi_documentary_resume_requires_budget() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if old.status = 'failed' and new.status in ('queued','running') and old.retry_count >= 3 and new.retry_count <= old.retry_count
     and not exists (select 1 from public.pi_recovery_budgets b
                     join public.pi_recovery_resume_authorizations r on r.project_id = b.project_id and r.transaction_id is not null
                     where b.job_id = old.id and b.owner_id = old.user_id and b.status = 'ACTIVE') then
    raise exception 'spend authorization required: open/resume a recovery budget for job % before requeueing', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.pi_documentary_resume_requires_budget() from public, anon, authenticated;
drop trigger if exists pi_documentary_resume_requires_budget on public.documentary_script_jobs;
create trigger pi_documentary_resume_requires_budget before update of status on public.documentary_script_jobs
  for each row execute function public.pi_documentary_resume_requires_budget();
create or replace function public.pi_recovery_resume_authorization(p_project_id text, p_authorization_ref text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('authorized', count(*) > 0, 'transactionId', max(r.transaction_id))
  from public.pi_recovery_resume_authorizations r
  where r.project_id = p_project_id and r.authorization_ref = p_authorization_ref
    and length(trim(coalesce(p_authorization_ref, ''))) > 0 and r.transaction_id is not null and r.transaction_id::text <> ''
$$;
revoke all on function public.pi_recovery_resume_authorization(text, text) from public, anon, authenticated;
grant execute on function public.pi_recovery_resume_authorization(text, text) to service_role;
commit;
