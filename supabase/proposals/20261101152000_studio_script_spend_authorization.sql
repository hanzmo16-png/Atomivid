-- PROPOSAL (NOT APPLIED). DESIGN / review-only. USD 0.
-- Do NOT run supabase db push, apply-supabase-migration, or this file against production or staging.
-- Auditor: ChatGPT AUDITADO-BLOQUEADO T-20261101-1520. Base tip 4f88e640 (#268).
--
-- Durable spend authorization for Podcast Studio long scripts whose ledger project_id is
-- studio-script:<owner uuid>:<job uuid> BEFORE a podcast_studio_episodes row exists.
-- The podcast-% gate (pi_spend_authorizations / pi_open_spend_authorization) cannot own this:
-- its CHECK is podcast-% and its owner proof is podcast_episodes.user_id. Putting studio
-- scripts in that prefix was the P0 of 2026-11-01 (every call stayed RESERVED).
--
-- Triple match, closed in the database, not in app code:
--   project_id        derived here from auth.users id + job uuid (never accepted as a free string)
--   authorization_ref stored on the row, immutable
--   transaction_id    txid_current() of the OPEN transaction, forced by trigger, not a caller argument
-- pi_submit_with_supply copies that triple onto pi_studio_script_spend_grants after a successful
-- RESERVED→SUBMITTED. The app only passes the idempotency key. service_role cannot INSERT the
-- tables (REVOKE); only these SECURITY DEFINER functions can, and only with a transaction-local GUC.
--
-- Predecessor: whatever public.pi_submit_with_supply(text, numeric) is installed (production wrapper
-- included). It is renamed once to pi_submit_with_supply_pre_studio_script and EXECUTE is revoked
-- from service_role so the studio gate cannot be skipped by calling the inner function. Non
-- studio-script projects are delegated unchanged.
--
-- Rollback: 20261101152000_studio_script_spend_authorization.rollback.sql
-- (restores the previous submit function; KEEPS the tables as an audit trail).
-- Review: docs/STUDIO_SCRIPT_SPEND_AUTHORIZATION.md
-- Disposable proof: bash scripts/qa/studio-script-auth-db.sh

begin;

create or replace function public.pi_studio_script_project(p_owner_id uuid, p_job_id uuid) returns text
language sql immutable security invoker set search_path = '' as $$
  select 'studio-script:' || p_owner_id::text || ':' || p_job_id::text
$$;

create table if not exists public.pi_studio_script_authorizations (
  project_id text primary key,
  owner_id uuid not null,
  job_id uuid not null unique,
  cap_usd numeric(12,4) not null check (cap_usd > 0 and cap_usd <= 50),
  authorization_ref text not null check (length(trim(authorization_ref)) > 0),
  transaction_id bigint not null check (transaction_id > 0),
  baseline_keys text[] not null default '{}',
  status text not null default 'ACTIVE' check (status in ('ACTIVE','CLOSED','EXPIRED','BOUND')),
  episode_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  check (project_id = 'studio-script:' || owner_id::text || ':' || job_id::text),
  check (expires_at > created_at),
  check (status <> 'BOUND' or episode_id is not null),
  check (status = 'BOUND' or episode_id is null)
);
alter table public.pi_studio_script_authorizations enable row level security;
create index if not exists pi_studio_script_authorizations_expiry
  on public.pi_studio_script_authorizations (expires_at) where status = 'ACTIVE';

create table if not exists public.pi_studio_script_spend_grants (
  idempotency_key text primary key,
  project_id text not null,
  authorization_ref text not null check (length(trim(authorization_ref)) > 0),
  transaction_id bigint not null check (transaction_id > 0),
  reserved_usd numeric(12,4) not null check (reserved_usd > 0),
  created_at timestamptz not null default clock_timestamp()
);
alter table public.pi_studio_script_spend_grants enable row level security;

-- Inheritance record only. Does not move script USD into the episode media budget.
create table if not exists public.pi_studio_script_episode_bindings (
  episode_id uuid primary key,
  project_id text not null unique,
  owner_id uuid not null,
  job_id uuid not null unique,
  authorization_ref text not null check (length(trim(authorization_ref)) > 0),
  transaction_id bigint not null check (transaction_id > 0),
  bound_at timestamptz not null default clock_timestamp()
);
alter table public.pi_studio_script_episode_bindings enable row level security;

create or replace function public.pi_studio_script_authorization_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if current_setting('atomivid.studio_script_open', true) is distinct from '1' then
      raise exception 'studio script authorizations are opened only by pi_open_studio_script_authorization';
    end if;
    new.transaction_id := txid_current();
    if new.transaction_id is null or new.transaction_id <= 0 then
      raise exception 'transaction_id must be the database transaction id';
    end if;
    if new.status is distinct from 'ACTIVE' or new.episode_id is not null or new.closed_at is not null then
      raise exception 'a new studio script authorization starts ACTIVE and unbound';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then raise exception 'studio script authorizations cannot be deleted'; end if;
  if new.project_id is distinct from old.project_id or new.owner_id is distinct from old.owner_id
     or new.job_id is distinct from old.job_id or new.cap_usd is distinct from old.cap_usd
     or new.authorization_ref is distinct from old.authorization_ref
     or new.transaction_id is distinct from old.transaction_id
     or new.baseline_keys is distinct from old.baseline_keys
     or new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at
  then raise exception 'studio script authorization is immutable'; end if;
  if old.status = 'ACTIVE' and new.status in ('CLOSED','EXPIRED','BOUND') then
    if new.closed_at is null then raise exception 'closing a studio script authorization requires closed_at'; end if;
    if new.status = 'BOUND' then
      if new.episode_id is null or old.episode_id is not null then
        raise exception 'bind requires a new episode id';
      end if;
    elsif new.episode_id is distinct from old.episode_id then
      raise exception 'episode id changes only when binding';
    end if;
    return new;
  end if;
  raise exception 'a terminal studio script authorization cannot change';
end $$;
drop trigger if exists pi_studio_script_authorization_guard on public.pi_studio_script_authorizations;
create trigger pi_studio_script_authorization_guard
  before insert or update or delete on public.pi_studio_script_authorizations
  for each row execute function public.pi_studio_script_authorization_guard();

create or replace function public.pi_studio_script_grant_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then raise exception 'studio script spend grants cannot be changed'; end if;
  if current_setting('atomivid.studio_script_grant', true) is distinct from '1' then
    raise exception 'studio script spend grants are written only by pi_submit_with_supply';
  end if;
  if not exists (
    select 1 from public.pi_studio_script_authorizations a
    where a.project_id = new.project_id and a.authorization_ref = new.authorization_ref and a.transaction_id = new.transaction_id
  ) then
    raise exception 'spend grant triple does not match a studio script authorization';
  end if;
  return new;
end $$;
drop trigger if exists pi_studio_script_grant_guard on public.pi_studio_script_spend_grants;
create trigger pi_studio_script_grant_guard
  before insert or update or delete on public.pi_studio_script_spend_grants
  for each row execute function public.pi_studio_script_grant_guard();

create or replace function public.pi_studio_script_binding_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then raise exception 'studio script episode bindings cannot be changed'; end if;
  if current_setting('atomivid.studio_script_bind', true) is distinct from '1' then
    raise exception 'studio script episode bindings are written only by pi_bind_studio_script_authorization';
  end if;
  if not exists (
    select 1 from public.pi_studio_script_authorizations a
    where a.project_id = new.project_id and a.owner_id = new.owner_id and a.job_id = new.job_id
      and a.authorization_ref = new.authorization_ref and a.transaction_id = new.transaction_id
      and a.status = 'BOUND' and a.episode_id = new.episode_id
  ) then
    raise exception 'episode binding triple does not match a BOUND studio script authorization';
  end if;
  return new;
end $$;
drop trigger if exists pi_studio_script_binding_guard on public.pi_studio_script_episode_bindings;
create trigger pi_studio_script_binding_guard
  before insert or update or delete on public.pi_studio_script_episode_bindings
  for each row execute function public.pi_studio_script_binding_guard();

-- One authorization per job. Owner comes from auth.users, never from the project_id string the caller wishes.
-- baseline_keys stays empty: spend already committed on this project (BASE DULCE under the lesser contract)
-- COUNTS against the cap. RESERVED rows are not a reason to block open; they count only if later submitted.
-- Uncertain rows block open so an in-flight provider call is reconciled before a new ceiling exists.
create or replace function public.pi_open_studio_script_authorization(
  p_owner_id uuid, p_job_id uuid, p_cap_usd numeric, p_authorization_ref text, p_ttl_hours numeric default 24
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  pid text;
  existing public.pi_studio_script_authorizations%rowtype;
begin
  if p_owner_id is null or p_job_id is null then
    return jsonb_build_object('opened', false, 'reason', 'owner and job required');
  end if;
  if p_authorization_ref is null or length(trim(p_authorization_ref)) = 0 then
    return jsonb_build_object('opened', false, 'reason', 'authorization_ref required');
  end if;
  if p_cap_usd is null or p_cap_usd <= 0 or p_cap_usd > 50 then
    return jsonb_build_object('opened', false, 'reason', 'cap out of range');
  end if;
  if p_ttl_hours is null or p_ttl_hours <= 0 or p_ttl_hours > 72 then
    return jsonb_build_object('opened', false, 'reason', 'ttl out of range');
  end if;
  if not exists (select 1 from auth.users u where u.id = p_owner_id) then
    return jsonb_build_object('opened', false, 'reason', 'owner not found');
  end if;
  pid := public.pi_studio_script_project(p_owner_id, p_job_id);
  select * into existing from public.pi_studio_script_authorizations where project_id = pid;
  if found then
    return jsonb_build_object('opened', false, 'reason', 'already_open', 'projectId', existing.project_id,
      'authorizationRef', existing.authorization_ref, 'transactionId', existing.transaction_id::text,
      'capUsd', existing.cap_usd, 'status', existing.status);
  end if;
  if exists (select 1 from public.pi_studio_script_authorizations where job_id = p_job_id) then
    return jsonb_build_object('opened', false, 'reason', 'job owned by someone else');
  end if;
  if exists (
    select 1 from public.pi_paid_operations
    where project_id = pid and status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
  ) then
    return jsonb_build_object('opened', false, 'reason', 'uncertain operations must be reconciled first');
  end if;
  begin
    perform set_config('atomivid.studio_script_open', '1', true);
    insert into public.pi_studio_script_authorizations(
      project_id, owner_id, job_id, cap_usd, authorization_ref, transaction_id, baseline_keys, expires_at
    ) values (
      pid, p_owner_id, p_job_id, p_cap_usd, trim(p_authorization_ref), txid_current(), '{}',
      clock_timestamp() + (p_ttl_hours * interval '1 hour')
    );
  exception when unique_violation then
    select * into existing from public.pi_studio_script_authorizations where project_id = pid;
    if found then
      return jsonb_build_object('opened', false, 'reason', 'already_open', 'projectId', existing.project_id,
        'authorizationRef', existing.authorization_ref, 'transactionId', existing.transaction_id::text,
        'capUsd', existing.cap_usd, 'status', existing.status);
    end if;
    return jsonb_build_object('opened', false, 'reason', 'job owned by someone else');
  end;
  perform set_config('atomivid.studio_script_open', '', true);
  select * into existing from public.pi_studio_script_authorizations where project_id = pid;
  return jsonb_build_object('opened', true, 'projectId', existing.project_id, 'authorizationRef', existing.authorization_ref,
    'transactionId', existing.transaction_id::text, 'capUsd', existing.cap_usd, 'status', existing.status,
    'expiresAt', existing.expires_at, 'baselineOperations', cardinality(existing.baseline_keys));
end $$;

create or replace function public.pi_studio_script_authorization_usage(p_project_id text, p_exclude_key text default null)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'projectId', a.project_id,
    'ownerId', a.owner_id,
    'jobId', a.job_id,
    'capUsd', a.cap_usd,
    'status', a.status,
    'authorizationRef', a.authorization_ref,
    'transactionId', a.transaction_id::text,
    'expiresAt', a.expires_at,
    'episodeId', a.episode_id,
    'committedUsd', coalesce(sum(coalesce(o.committed_usd, o.reserved_usd)) filter (where o.status = 'COMMITTED'), 0),
    'pendingUsd', coalesce(sum(o.reserved_usd) filter (where o.status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
                     or (o.status = 'REFUNDED' and not coalesce(o.supply_reconciled, false))), 0),
    'remainingUsd', a.cap_usd
      - coalesce(sum(coalesce(o.committed_usd, o.reserved_usd)) filter (where o.status = 'COMMITTED'), 0)
      - coalesce(sum(o.reserved_usd) filter (where o.status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
          or (o.status = 'REFUNDED' and not coalesce(o.supply_reconciled, false))), 0))
  from public.pi_studio_script_authorizations a
  left join public.pi_paid_operations o
    on o.project_id = a.project_id
   and o.method <> 'capacity_hold'
   and o.idempotency_key is distinct from p_exclude_key
   and not (o.idempotency_key = any(a.baseline_keys))
  where a.project_id = p_project_id
  group by a.project_id
$$;

create or replace function public.pi_close_studio_script_authorization(p_owner_id uuid, p_job_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.pi_studio_script_authorizations%rowtype; pid text;
begin
  if p_owner_id is null or p_job_id is null then
    return jsonb_build_object('closed', false, 'reason', 'owner and job required');
  end if;
  pid := public.pi_studio_script_project(p_owner_id, p_job_id);
  select * into a from public.pi_studio_script_authorizations where project_id = pid for update;
  if not found then return jsonb_build_object('closed', false, 'reason', 'authorization missing'); end if;
  if a.owner_id is distinct from p_owner_id then
    return jsonb_build_object('closed', false, 'reason', 'authorization owner mismatch');
  end if;
  if a.status <> 'ACTIVE' then
    return jsonb_build_object('closed', false, 'reason', 'authorization closed', 'status', a.status);
  end if;
  update public.pi_studio_script_authorizations
    set status = 'CLOSED', closed_at = clock_timestamp()
    where project_id = pid;
  return jsonb_build_object('closed', true, 'projectId', pid, 'authorizationRef', a.authorization_ref,
    'transactionId', a.transaction_id::text);
end $$;

-- Lazy expiry is also done inside pi_submit_with_supply. This sweeper is not scheduled by this proposal.
create or replace function public.pi_expire_studio_script_authorizations()
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.pi_studio_script_authorizations
    set status = 'EXPIRED', closed_at = clock_timestamp()
    where status = 'ACTIVE' and expires_at <= clock_timestamp();
  get diagnostics n = row_count;
  return jsonb_build_object('expired', n);
end $$;

-- Binds the script authorization to a draft podcast_studio_episodes row of the SAME owner.
-- Status becomes BOUND, which stops further script submits. The triple is copied into
-- pi_studio_script_episode_bindings. Script USD is NOT added to authorized_usd.
create or replace function public.pi_bind_studio_script_authorization(p_owner_id uuid, p_job_id uuid, p_episode_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.pi_studio_script_authorizations%rowtype;
  pid text;
  ep_owner uuid;
  ep_status text;
begin
  if p_owner_id is null or p_job_id is null or p_episode_id is null then
    return jsonb_build_object('bound', false, 'reason', 'owner, job and episode required');
  end if;
  pid := public.pi_studio_script_project(p_owner_id, p_job_id);
  select * into a from public.pi_studio_script_authorizations where project_id = pid for update;
  if not found then return jsonb_build_object('bound', false, 'reason', 'authorization missing'); end if;
  if a.owner_id is distinct from p_owner_id or pid is distinct from public.pi_studio_script_project(a.owner_id, a.job_id) then
    return jsonb_build_object('bound', false, 'reason', 'authorization owner mismatch');
  end if;
  if a.status = 'ACTIVE' and a.expires_at <= clock_timestamp() then
    update public.pi_studio_script_authorizations set status = 'EXPIRED', closed_at = clock_timestamp() where project_id = pid;
    return jsonb_build_object('bound', false, 'reason', 'authorization expired');
  end if;
  if a.status = 'BOUND' and a.episode_id = p_episode_id then
    return jsonb_build_object('bound', true, 'state', 'already_bound', 'projectId', pid, 'episodeId', a.episode_id,
      'authorizationRef', a.authorization_ref, 'transactionId', a.transaction_id::text);
  end if;
  if a.status = 'BOUND' and a.episode_id is not null and a.episode_id is distinct from p_episode_id then
    return jsonb_build_object('bound', false, 'reason', 'job already bound', 'episodeId', a.episode_id);
  end if;
  if a.status <> 'ACTIVE' then
    return jsonb_build_object('bound', false, 'reason', 'authorization closed', 'status', a.status);
  end if;
  begin
    execute 'select user_id, status from public.podcast_studio_episodes where id = $1 for update'
      into ep_owner, ep_status using p_episode_id;
  exception when undefined_table then
    return jsonb_build_object('bound', false, 'reason', 'studio episodes table missing');
  end;
  if ep_owner is null then return jsonb_build_object('bound', false, 'reason', 'episode not found'); end if;
  if ep_owner is distinct from p_owner_id then
    return jsonb_build_object('bound', false, 'reason', 'authorization owner mismatch');
  end if;
  if ep_status is distinct from 'draft' then
    return jsonb_build_object('bound', false, 'reason', 'episode not bindable');
  end if;
  if exists (select 1 from public.pi_studio_script_episode_bindings b where b.episode_id = p_episode_id and b.project_id is distinct from pid) then
    return jsonb_build_object('bound', false, 'reason', 'episode already bound');
  end if;
  update public.pi_studio_script_authorizations
    set status = 'BOUND', episode_id = p_episode_id, closed_at = clock_timestamp()
    where project_id = pid;
  perform set_config('atomivid.studio_script_bind', '1', true);
  insert into public.pi_studio_script_episode_bindings(
    episode_id, project_id, owner_id, job_id, authorization_ref, transaction_id
  ) values (p_episode_id, pid, a.owner_id, a.job_id, a.authorization_ref, a.transaction_id);
  perform set_config('atomivid.studio_script_bind', '', true);
  return jsonb_build_object('bound', true, 'state', 'bound', 'projectId', pid, 'episodeId', p_episode_id,
    'authorizationRef', a.authorization_ref, 'transactionId', a.transaction_id::text);
end $$;

do $$ begin
  if to_regprocedure('public.pi_submit_with_supply_pre_studio_script(text,numeric)') is null then
    alter function public.pi_submit_with_supply(text, numeric) rename to pi_submit_with_supply_pre_studio_script;
  end if;
end $$;
alter function public.pi_submit_with_supply_pre_studio_script(text, numeric) set search_path = '';
revoke all on function public.pi_submit_with_supply_pre_studio_script(text, numeric) from public, anon, authenticated, service_role;

-- studio-script:% is fail-closed. Every other project, including podcast-%, is delegated byte-for-byte
-- to the predecessor (the podcast authorization wrapper, when that proposal is already installed).
create or replace function public.pi_submit_with_supply(p_key text, p_units numeric default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.pi_paid_operations%rowtype;
  a public.pi_studio_script_authorizations%rowtype;
  usage jsonb;
  result jsonb;
  owner_ok boolean;
  canonical text;
begin
  select * into o from public.pi_paid_operations where idempotency_key = p_key;
  if found and o.status = 'RESERVED' and lower(o.project_id) like 'studio-script:%' then
    if o.project_id !~ '^studio-script:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return jsonb_build_object('submitted', false, 'reason', 'authorization owner mismatch');
    end if;
    select * into a from public.pi_studio_script_authorizations where project_id = o.project_id for update;
    if not found then return jsonb_build_object('submitted', false, 'reason', 'authorization missing'); end if;
    if a.status = 'ACTIVE' and a.expires_at <= clock_timestamp() then
      update public.pi_studio_script_authorizations set status = 'EXPIRED', closed_at = clock_timestamp() where project_id = a.project_id;
      return jsonb_build_object('submitted', false, 'reason', 'authorization expired');
    end if;
    if a.status <> 'ACTIVE' then
      return jsonb_build_object('submitted', false, 'reason',
        case when a.status = 'EXPIRED' then 'authorization expired' else 'authorization closed' end, 'capUsd', a.cap_usd);
    end if;
    canonical := public.pi_studio_script_project(a.owner_id, a.job_id);
    select exists(select 1 from auth.users u where u.id = a.owner_id) into owner_ok;
    if canonical is distinct from o.project_id or not coalesce(owner_ok, false)
       or a.transaction_id is null or a.transaction_id <= 0
       or a.authorization_ref is null or length(trim(a.authorization_ref)) = 0 then
      return jsonb_build_object('submitted', false, 'reason', 'authorization owner mismatch');
    end if;
    select * into o from public.pi_paid_operations where idempotency_key = p_key;
    if o.status <> 'RESERVED' then return jsonb_build_object('submitted', false, 'reason', 'already_claimed'); end if;
    if o.reserved_usd is null or o.reserved_usd <= 0 or o.reserved_usd::text in ('NaN','Infinity','-Infinity') then
      return jsonb_build_object('submitted', false, 'reason', 'authorization cost unverified');
    end if;
    usage := public.pi_studio_script_authorization_usage(o.project_id, p_key);
    if usage is null then return jsonb_build_object('submitted', false, 'reason', 'authorization missing'); end if;
    if (usage->>'committedUsd')::numeric + (usage->>'pendingUsd')::numeric + o.reserved_usd > a.cap_usd then
      return jsonb_build_object('submitted', false, 'reason', 'authorization exceeded', 'capUsd', a.cap_usd,
        'committedUsd', usage->'committedUsd', 'pendingUsd', usage->'pendingUsd', 'requestedUsd', o.reserved_usd);
    end if;
    result := public.pi_submit_with_supply_pre_studio_script(p_key, p_units);
    if coalesce((result->>'submitted')::boolean, false) then
      perform set_config('atomivid.studio_script_grant', '1', true);
      insert into public.pi_studio_script_spend_grants(idempotency_key, project_id, authorization_ref, transaction_id, reserved_usd)
      values (p_key, a.project_id, a.authorization_ref, a.transaction_id, o.reserved_usd);
      perform set_config('atomivid.studio_script_grant', '', true);
    end if;
    return result;
  end if;
  return public.pi_submit_with_supply_pre_studio_script(p_key, p_units);
end $$;

revoke all on function public.pi_studio_script_project(uuid, uuid) from public, anon, authenticated;
grant execute on function public.pi_studio_script_project(uuid, uuid) to service_role;
revoke all on function public.pi_open_studio_script_authorization(uuid, uuid, numeric, text, numeric) from public, anon, authenticated;
grant execute on function public.pi_open_studio_script_authorization(uuid, uuid, numeric, text, numeric) to service_role;
revoke all on function public.pi_studio_script_authorization_usage(text, text) from public, anon, authenticated;
grant execute on function public.pi_studio_script_authorization_usage(text, text) to service_role;
revoke all on function public.pi_close_studio_script_authorization(uuid, uuid) from public, anon, authenticated;
grant execute on function public.pi_close_studio_script_authorization(uuid, uuid) to service_role;
revoke all on function public.pi_expire_studio_script_authorizations() from public, anon, authenticated;
grant execute on function public.pi_expire_studio_script_authorizations() to service_role;
revoke all on function public.pi_bind_studio_script_authorization(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.pi_bind_studio_script_authorization(uuid, uuid, uuid) to service_role;
revoke all on function public.pi_submit_with_supply(text, numeric) from public, anon, authenticated;
grant execute on function public.pi_submit_with_supply(text, numeric) to service_role;
revoke all on function public.pi_studio_script_authorization_guard() from public, anon, authenticated, service_role;
revoke all on function public.pi_studio_script_grant_guard() from public, anon, authenticated, service_role;
revoke all on function public.pi_studio_script_binding_guard() from public, anon, authenticated, service_role;
revoke all on table public.pi_studio_script_authorizations from public, anon, authenticated, service_role;
revoke all on table public.pi_studio_script_spend_grants from public, anon, authenticated, service_role;
revoke all on table public.pi_studio_script_episode_bindings from public, anon, authenticated, service_role;

comment on table public.pi_studio_script_authorizations is
  'DESIGN proposal 20261101152000. Durable pre-episode authorization for studio-script:<owner>:<job>. Not a podcast episode cap. Do not apply without the review in docs/STUDIO_SCRIPT_SPEND_AUTHORIZATION.md.';

commit;
