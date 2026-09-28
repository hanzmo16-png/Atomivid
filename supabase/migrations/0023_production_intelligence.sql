-- Production Intelligence V1: idempotent paid-operation ledger, append-only telemetry,
-- policy registry, immutable memory snapshots and project pins, provider account
-- registry (non-secret) and capacity snapshots.
-- All tables are service-role only: RLS is enabled with NO client policies.
-- Numbered 0023 because 0020-0022 exist on unmerged branches (audiovisual, voices, tts podcast).

create or replace function public.pi_reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only/immutable (% rejected)', tg_table_name, tg_op;
end $$;

-- Paid operations: one row per idempotency key; status moves forward only.
create table if not exists public.pi_paid_operations (
  idempotency_key text primary key,
  project_id text not null,
  shot_id text not null,
  provider text not null,
  model text not null,
  method text not null,
  attempt_kind text not null,
  reserved_usd numeric(12,4) not null check (reserved_usd >= 0),
  committed_usd numeric(12,4) check (committed_usd is null or committed_usd >= 0),
  status text not null check (status in ('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','COMMITTED','REFUNDED','RECONCILIATION_REQUIRED')),
  provider_job_id text,
  result_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pi_paid_operations_project_idx on public.pi_paid_operations (project_id);
create index if not exists pi_paid_operations_open_idx on public.pi_paid_operations (status) where status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED');

create or replace function public.pi_paid_operation_forward_only() returns trigger
language plpgsql as $$
declare
  rank_old int := array_position(array['RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED','COMMITTED','REFUNDED'], old.status);
  rank_new int := array_position(array['RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED','COMMITTED','REFUNDED'], new.status);
begin
  if old.status in ('COMMITTED','REFUNDED') then raise exception 'paid operation % is final (%)', old.idempotency_key, old.status; end if;
  if rank_new < rank_old then raise exception 'paid operation % cannot move back from % to %', old.idempotency_key, old.status, new.status; end if;
  if new.idempotency_key <> old.idempotency_key or new.project_id <> old.project_id then raise exception 'identity fields are immutable'; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists pi_paid_operations_forward on public.pi_paid_operations;
create trigger pi_paid_operations_forward before update on public.pi_paid_operations for each row execute function public.pi_paid_operation_forward_only();
drop trigger if exists pi_paid_operations_no_delete on public.pi_paid_operations;
create trigger pi_paid_operations_no_delete before delete on public.pi_paid_operations for each row execute function public.pi_reject_mutation();

-- Telemetry: append-only events (attempt / outcome / decision).
create table if not exists public.pi_telemetry_events (
  event_id text primary key,
  type text not null check (type in ('attempt','outcome','decision')),
  project_id text not null,
  shot_id text,
  attempt_id text,
  human_intervention text check (human_intervention in ('none','human')),
  payload jsonb not null,
  recorded_at timestamptz not null default now()
);
create index if not exists pi_telemetry_project_idx on public.pi_telemetry_events (project_id, recorded_at);
create index if not exists pi_telemetry_attempt_idx on public.pi_telemetry_events (attempt_id);
drop trigger if exists pi_telemetry_append_only on public.pi_telemetry_events;
create trigger pi_telemetry_append_only before update or delete on public.pi_telemetry_events for each row execute function public.pi_reject_mutation();

-- Policy registry + explicit promotion history.
create table if not exists public.pi_policy_versions (
  policy_version text primary key,
  status text not null check (status in ('CANDIDATE','SHADOW','ACTIVE','RETIRED')),
  params jsonb not null,
  notes text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists pi_one_active_policy on public.pi_policy_versions ((status)) where status = 'ACTIVE';

create table if not exists public.pi_policy_history (
  id bigint generated always as identity primary key,
  policy_version text not null references public.pi_policy_versions (policy_version),
  from_status text not null,
  to_status text not null,
  actor text not null,
  reason text not null check (length(trim(reason)) > 0),
  at timestamptz not null default now()
);
drop trigger if exists pi_policy_history_append_only on public.pi_policy_history;
create trigger pi_policy_history_append_only before update or delete on public.pi_policy_history for each row execute function public.pi_reject_mutation();

-- Memory snapshots and project pins are immutable once written.
create table if not exists public.pi_memory_snapshots (
  memory_snapshot_id text primary key,
  as_of timestamptz not null,
  window_days int not null check (window_days > 0),
  cells jsonb not null,
  created_at timestamptz not null default now()
);
drop trigger if exists pi_memory_snapshots_immutable on public.pi_memory_snapshots;
create trigger pi_memory_snapshots_immutable before update or delete on public.pi_memory_snapshots for each row execute function public.pi_reject_mutation();

create table if not exists public.pi_project_pins (
  project_id text primary key,
  policy_version text not null references public.pi_policy_versions (policy_version),
  profile_version text not null,
  contract_version text not null,
  rate_card_version text not null,
  memory_snapshot_id text not null references public.pi_memory_snapshots (memory_snapshot_id),
  pinned_at timestamptz not null default now()
);
drop trigger if exists pi_project_pins_immutable on public.pi_project_pins;
create trigger pi_project_pins_immutable before update or delete on public.pi_project_pins for each row execute function public.pi_reject_mutation();

-- Asset state transitions (the QA gate's audit trail).
create table if not exists public.pi_asset_transitions (
  id bigint generated always as identity primary key,
  project_id text not null,
  asset_id text not null,
  from_state text not null,
  to_state text not null,
  evidence jsonb not null default '[]'::jsonb,
  at timestamptz not null default now()
);
create index if not exists pi_asset_transitions_asset_idx on public.pi_asset_transitions (project_id, asset_id, at);
drop trigger if exists pi_asset_transitions_append_only on public.pi_asset_transitions;
create trigger pi_asset_transitions_append_only before update or delete on public.pi_asset_transitions for each row execute function public.pi_reject_mutation();

-- Provider account registry: non-secret metadata; the secret is referenced by NAME only.
create table if not exists public.pi_provider_accounts (
  provider text primary key,
  production_account_label text not null,
  workspace_identifier text,
  plan text not null,
  secret_reference_name text not null check (secret_reference_name ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  renewal_date date,
  status text not null check (status in ('active','suspended','unknown')),
  balance_source text not null check (balance_source in ('provider_api','derived_from_ledger','none')),
  notes text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.pi_capacity_snapshots (
  id bigint generated always as identity primary key,
  provider text not null references public.pi_provider_accounts (provider),
  unit text not null check (unit in ('character','usd','credit')),
  available numeric,
  reserved numeric not null default 0,
  pending numeric not null default 0,
  renewal_date date,
  health text not null check (health in ('OK','DEGRADED','DOWN','UNCHECKED')),
  reliability text not null check (reliability in ('provider_api','derived_from_ledger','manual_entry','none')),
  derived_estimate numeric,
  status text not null check (status in ('GREEN','YELLOW','RED','UNKNOWN')),
  -- UNKNOWN can never be stored as GREEN: a GREEN row needs a provider-reported balance.
  constraint pi_capacity_green_needs_balance check (status <> 'GREEN' or (available is not null and reliability in ('provider_api','manual_entry'))),
  checked_at timestamptz not null default now()
);
create index if not exists pi_capacity_provider_idx on public.pi_capacity_snapshots (provider, checked_at desc);

alter table public.pi_paid_operations enable row level security;
alter table public.pi_telemetry_events enable row level security;
alter table public.pi_policy_versions enable row level security;
alter table public.pi_policy_history enable row level security;
alter table public.pi_memory_snapshots enable row level security;
alter table public.pi_project_pins enable row level security;
alter table public.pi_asset_transitions enable row level security;
alter table public.pi_provider_accounts enable row level security;
alter table public.pi_capacity_snapshots enable row level security;
-- Intentionally no policies: only the service role (which bypasses RLS) reads or writes.
