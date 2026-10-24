-- PROPOSAL (NOT APPLIED). Travis Walton Ep. 2 / incident PR #194 (job e8048599).
-- Persistent per-project spend authorization, enforced INSIDE pi_submit_with_supply, atomically, before any
-- provider call. Fail closed: a podcast ('podcast-<episode>')
-- paid call without a stored ACTIVE authorization of the episode's owner is refused. Documentary projects keep
-- pi_recovery_budgets (unchanged): a first-run script has none by design, so the DB cannot require it for every
-- documentary call without blocking normal generation; the RESUME path now requires it in the app
-- (script-job-resume.ts → storedAuthorizationRefusal) before requeueing.
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

create or replace function public.pi_spend_authorization_guard() returns trigger language plpgsql as $$
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
returns jsonb language plpgsql security definer set search_path = public as $$
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

create or replace function public.pi_spend_authorization_usage(p_project_id text, p_exclude_key text default null)
returns jsonb language sql stable as $$
  select jsonb_build_object('capUsd', a.cap_usd, 'status', a.status,
    'committedUsd', coalesce(sum(coalesce(o.committed_usd, o.reserved_usd)) filter (where o.status = 'COMMITTED'), 0),
    'pendingUsd', coalesce(sum(o.reserved_usd) filter (where o.status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')), 0),
    'remainingUsd', a.cap_usd - coalesce(sum(coalesce(o.committed_usd, o.reserved_usd)) filter (where o.status = 'COMMITTED'), 0)
                              - coalesce(sum(o.reserved_usd) filter (where o.status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')), 0))
  from public.pi_spend_authorizations a
  left join public.pi_paid_operations o on o.project_id = a.project_id and o.idempotency_key is distinct from p_exclude_key and not (o.idempotency_key = any(a.baseline_keys))
  where a.project_id = p_project_id group by a.cap_usd, a.status
$$;

-- Keep the current function body as-is under a new name; the new entry point adds the authorization rule first.
alter function public.pi_submit_with_supply(text, numeric) rename to pi_submit_with_supply_pre_authz;

create or replace function public.pi_submit_with_supply(p_key text, p_units numeric) returns jsonb language plpgsql as $$
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

commit;
