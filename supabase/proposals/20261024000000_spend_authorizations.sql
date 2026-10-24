-- PROPOSAL (NOT APPLIED). Travis Walton Ep. 2 / incident PR #194 (job e8048599).
-- Persistent per-project spend authorization, enforced INSIDE pi_submit_with_supply, atomically, before any
-- provider call. Fail closed: a podcast ('podcast-<episode>')
-- paid call without a stored ACTIVE authorization of the episode's owner is refused. Documentary projects keep
-- pi_recovery_budgets (unchanged): a first-run script has none by design, so the DB cannot require it for every
-- documentary call without blocking normal generation; the RESUME path now requires it in the app
-- (script-job-resume.ts → storedAuthorizationRefusal) before requeueing, and since audit P0-1 also a durable row in
-- pi_recovery_resume_authorizations (via pi_recovery_resume_authorization). Every function: SECURITY DEFINER or
-- trigger, search_path = '', qualified names, EXECUTE only service_role (+ owner postgres).
-- Concurrency: the authorization row is locked FOR UPDATE, then usage is re-read in a fresh statement, so two
-- racing resumes can never both pass the same remaining amount. Rollback: *_spend_authorizations.rollback.sql.
begin;

create table if not exists public.pi_spend_authorizations (
  project_id text primary key check (project_id like 'podcast-%'),
  owner_id uuid not null,
  cap_usd numeric(12,4) not null check (cap_usd > 0 and cap_usd <= 100),
  authorization_ref text not null check (length(trim(authorization_ref)) > 0),
  baseline_keys text[] not null default '{}',
  status text not null default 'ACTIVE' check (status in ('ACTIVE','CLOSED')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
alter table public.pi_spend_authorizations enable row level security; -- service role only

create or replace function public.pi_spend_authorization_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'spend authorizations cannot be deleted'; end if;
  if new.project_id is distinct from old.project_id or new.owner_id is distinct from old.owner_id or new.cap_usd is distinct from old.cap_usd
     or new.authorization_ref is distinct from old.authorization_ref or new.baseline_keys is distinct from old.baseline_keys or new.created_at is distinct from old.created_at
  then raise exception 'spend authorization is immutable (open a new one)'; end if;
  if old.status = 'CLOSED' and new.status <> 'CLOSED' then raise exception 'a closed authorization cannot be reopened'; end if;
  return new;
end $$;
drop trigger if exists pi_spend_authorization_guard on public.pi_spend_authorizations;
create trigger pi_spend_authorization_guard before update or delete on public.pi_spend_authorizations for each row execute function public.pi_spend_authorization_guard();

-- Owner opens it (one per episode; immutable). Owner identity comes from the episode row, never from the caller.
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
  -- Baseline = only operations already SETTLED before the authorization (never a RESERVED one: a reservation left by a
  -- refused attempt would otherwise be submitted later outside the cap — closure audit grok/podcast-audiovisual-cierre).
  select coalesce(array_agg(idempotency_key order by idempotency_key), '{}') into keys from public.pi_paid_operations where project_id = pid and status <> 'RESERVED';
  insert into public.pi_spend_authorizations(project_id, owner_id, cap_usd, authorization_ref, baseline_keys) values (pid, e.user_id, p_cap_usd, p_authorization_ref, keys);
  return jsonb_build_object('opened', true, 'projectId', pid, 'capUsd', p_cap_usd, 'baselineOperations', cardinality(keys));
end $$;
revoke all on function public.pi_open_spend_authorization(uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.pi_open_spend_authorization(uuid, numeric, text) to service_role;

create or replace function public.pi_spend_authorization_usage(p_project_id text, p_exclude_key text default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('capUsd', a.cap_usd, 'status', a.status,
    'committedUsd', coalesce(sum(coalesce(o.committed_usd, o.reserved_usd)) filter (where o.status = 'COMMITTED'), 0),
    'pendingUsd', coalesce(sum(o.reserved_usd) filter (where o.status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
                     or (o.status = 'REFUNDED' and not coalesce(o.supply_reconciled, false))), 0),
    'remainingUsd', a.cap_usd - coalesce(sum(coalesce(o.committed_usd, o.reserved_usd)) filter (where o.status = 'COMMITTED'), 0)
                              - coalesce(sum(o.reserved_usd) filter (where o.status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
                                  or (o.status = 'REFUNDED' and not coalesce(o.supply_reconciled, false))), 0))
  from public.pi_spend_authorizations a
  left join public.pi_paid_operations o on o.project_id = a.project_id and o.method <> 'capacity_hold' and o.idempotency_key is distinct from p_exclude_key and not (o.idempotency_key = any(a.baseline_keys))
  where a.project_id = p_project_id group by a.cap_usd, a.status
$$;

-- Keep the current function body as-is under a new name; the new entry point adds the authorization rule first.
do $$ begin
  if to_regprocedure('public.pi_submit_with_supply_pre_authz(text,numeric)') is null then
    alter function public.pi_submit_with_supply(text, numeric) rename to pi_submit_with_supply_pre_authz;
  end if;
end $$;

-- Same security contract as production: SECURITY DEFINER, empty search_path, fully qualified names, service_role only.
create or replace function public.pi_submit_with_supply(p_key text, p_units numeric default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.pi_paid_operations%rowtype; a public.pi_spend_authorizations%rowtype; usage jsonb; owner_ok boolean;
begin
  select * into o from public.pi_paid_operations where idempotency_key = p_key;
  if found and o.status = 'RESERVED' then
    if o.project_id like 'podcast-%' then
      select * into a from public.pi_spend_authorizations where project_id = o.project_id for update;
      if not found then return jsonb_build_object('submitted', false, 'reason', 'authorization missing'); end if;
      if a.status <> 'ACTIVE' then return jsonb_build_object('submitted', false, 'reason', 'authorization closed', 'capUsd', a.cap_usd); end if;
      select exists(select 1 from public.podcast_episodes e where 'podcast-' || e.id::text = o.project_id and e.user_id = a.owner_id) into owner_ok;
      if not owner_ok then return jsonb_build_object('submitted', false, 'reason', 'authorization owner mismatch'); end if;
      select * into o from public.pi_paid_operations where idempotency_key = p_key; -- fresh read after the lock
      if o.status <> 'RESERVED' then return jsonb_build_object('submitted', false, 'reason', 'already_claimed'); end if;
      if o.reserved_usd is null or o.reserved_usd <= 0 or o.reserved_usd = 'NaN'::numeric then
        return jsonb_build_object('submitted', false, 'reason', 'authorization cost unverified'); end if;
      usage := public.pi_spend_authorization_usage(o.project_id, p_key);
      if (usage->>'committedUsd')::numeric + (usage->>'pendingUsd')::numeric + o.reserved_usd > a.cap_usd then
        return jsonb_build_object('submitted', false, 'reason', 'authorization exceeded', 'capUsd', a.cap_usd,
          'committedUsd', usage->'committedUsd', 'pendingUsd', usage->'pendingUsd', 'requestedUsd', o.reserved_usd); end if;
    end if;
  end if;
  return public.pi_submit_with_supply_pre_authz(p_key, p_units);
end $$;
alter function public.pi_submit_with_supply_pre_authz(text, numeric) set search_path = '';
revoke all on function public.pi_submit_with_supply_pre_authz(text, numeric) from public, anon, authenticated;
grant execute on function public.pi_submit_with_supply_pre_authz(text, numeric) to service_role;
revoke all on function public.pi_submit_with_supply(text, numeric) from public, anon, authenticated;
grant execute on function public.pi_submit_with_supply(text, numeric) to service_role;
revoke all on function public.pi_spend_authorization_usage(text, text) from public, anon, authenticated;
grant execute on function public.pi_spend_authorization_usage(text, text) to service_role;
revoke all on function public.pi_spend_authorization_guard() from public, anon, authenticated;
revoke all on table public.pi_spend_authorizations from public, anon, authenticated;

-- Durable resume authorization (audit P0-1): a resume needs a row in pi_recovery_resume_authorizations for
-- (project_id, authorization_ref) with a transaction_id. That table is closed even to service_role, so the app
-- reads it only through this read-only RPC.
create or replace function public.pi_recovery_resume_authorization(p_project_id text, p_authorization_ref text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('authorized', count(*) > 0, 'transactionId', max(r.transaction_id))
  from public.pi_recovery_resume_authorizations r
  where r.project_id = p_project_id and r.authorization_ref = p_authorization_ref
    and length(trim(coalesce(p_authorization_ref, ''))) > 0 and r.transaction_id is not null and r.transaction_id::text <> ''
$$;
revoke all on function public.pi_recovery_resume_authorization(text, text) from public, anon, authenticated;
grant execute on function public.pi_recovery_resume_authorization(text, text) to service_role;

-- Documentary backstop in the DB (PR #194 path): a job that used up its technical retries (retry_count >= 3) can go
-- back from 'failed' to 'queued' only with an ACTIVE recovery budget of the same owner. The app's normal
-- «Reintentar» (retry_count < 3) is unchanged. First-run documentary calls stay capped only by the global/provider
-- ceilings: their project id is not stored on the job, so the DB cannot require an authorization per call.
create or replace function public.pi_documentary_resume_requires_budget() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'failed' and new.status in ('queued','running') and old.retry_count >= 3 and new.retry_count <= old.retry_count
     and not exists (select 1 from public.pi_recovery_budgets b
                     join public.pi_recovery_resume_authorizations r on r.project_id = b.project_id and r.transaction_id is not null
                     where b.job_id = old.id and b.owner_id = old.user_id and b.status = 'ACTIVE') then
    raise exception 'spend authorization required: open/resume a recovery budget for job % before requeueing', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists pi_documentary_resume_requires_budget on public.documentary_script_jobs;
create trigger pi_documentary_resume_requires_budget before update of status on public.documentary_script_jobs
  for each row execute function public.pi_documentary_resume_requires_budget();
revoke all on function public.pi_documentary_resume_requires_budget() from public, anon, authenticated;

commit;
