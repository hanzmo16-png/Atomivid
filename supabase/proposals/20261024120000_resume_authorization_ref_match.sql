-- PROPOSAL (NOT APPLIED). P0 T-20261024-0724-chatgpt-02 — closes the post-PR198 DB bypass (T10c).
-- Depends on supabase/proposals/20261024000000_spend_authorizations.sql (PR #198, merged in 762714e) being present.
-- Bug: pi_documentary_resume_requires_budget joined pi_recovery_budgets to pi_recovery_resume_authorizations by
-- project_id ONLY, so a budget opened with authorization_ref A was requeued by a durable row for ref B (A/B).
-- Fix: the requeue of an exhausted documentary job (failed -> queued/running, retry_count >= 3) now requires an ACTIVE
-- budget of the same owner AND a durable row with the EXACT same project_id AND authorization_ref AND a non-null,
-- non-empty transaction_id. Rejection raises before the row is written (BEFORE trigger): 0 updates, 0 ops, 0 POSTs.
-- The trigger function is now SECURITY DEFINER (owner postgres): pi_recovery_resume_authorizations is closed even to
-- service_role, so an invoker-rights trigger could never read it from the app's service_role session.
-- Every function: SECURITY DEFINER, search_path = '', qualified names, EXECUTE only service_role (+ owner postgres).
-- Re-runnable. Rollback: 20261024120000_resume_authorization_ref_match.rollback.sql (restores the PR198 bodies).
begin;

create or replace function public.pi_documentary_resume_requires_budget() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'failed' and new.status in ('queued','running') and old.retry_count >= 3 and new.retry_count <= old.retry_count
     and not exists (select 1
                     from public.pi_recovery_budgets b
                     join public.pi_recovery_resume_authorizations r
                       on r.project_id = b.project_id
                      and r.authorization_ref = b.authorization_ref
                     where b.job_id = old.id
                       and b.owner_id = old.user_id
                       and b.status = 'ACTIVE'
                       and length(trim(coalesce(b.authorization_ref, ''))) > 0
                       and r.transaction_id is not null
                       and length(trim(r.transaction_id::text)) > 0) then
    raise exception 'spend authorization required: job % needs an ACTIVE recovery budget and a durable resume authorization with the same project_id and authorization_ref', old.id
      using errcode = 'P0001';
  end if;
  return new;
end $$;
alter function public.pi_documentary_resume_requires_budget() owner to postgres;
revoke all on function public.pi_documentary_resume_requires_budget() from public, anon, authenticated, service_role;
drop trigger if exists pi_documentary_resume_requires_budget on public.documentary_script_jobs;
create trigger pi_documentary_resume_requires_budget before update of status on public.documentary_script_jobs
  for each row execute function public.pi_documentary_resume_requires_budget();

-- Read-only RPC used by the app (script-job-resume.ts): same exact-match rule, empty inputs never authorize.
create or replace function public.pi_recovery_resume_authorization(p_project_id text, p_authorization_ref text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('authorized', count(*) > 0, 'transactionId', max(r.transaction_id))
  from public.pi_recovery_resume_authorizations r
  where r.project_id = p_project_id and r.authorization_ref = p_authorization_ref
    and length(trim(coalesce(p_project_id, ''))) > 0 and length(trim(coalesce(p_authorization_ref, ''))) > 0
    and r.transaction_id is not null and length(trim(r.transaction_id::text)) > 0
$$;
alter function public.pi_recovery_resume_authorization(text, text) owner to postgres;
revoke all on function public.pi_recovery_resume_authorization(text, text) from public, anon, authenticated;
grant execute on function public.pi_recovery_resume_authorization(text, text) to service_role;

commit;
