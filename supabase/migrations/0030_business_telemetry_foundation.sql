-- 0030: Business Telemetry Foundation V0 — COLLECT EARLY, AUTOMATE LATE.
-- Additive, non-destructive, re-runnable. Three append-only, backend-only tables:
--   business_events              the business event ledger (idempotent by idempotency_key / event_id)
--   business_event_rejections    what the single write path refused (reason + key hash, never the payload)
--   business_attribution_touches allowlisted UTM / click-id / landing-path touches per anonymous visitor
-- Security: RLS ENABLED with NO policies (service role / owner only), client privileges revoked, no USING (true).
-- Integrity: UPDATE and DELETE are rejected by trigger (append-only); metadata must be a JSON object;
-- money inside metadata always carries a currency (validated by the application schema, see taxonomy.ts).
-- Nothing here recalculates cost, capacity, Final Cut, YouTube or subscription state: those stay in their tables.

create or replace function public.bt_append_only() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception '% is append-only (% rejected)', tg_table_name, tg_op;
end $$;

create table if not exists public.business_events (
  event_id text primary key check (event_id ~ '^bev_[a-f0-9]{32}$'),
  event_type text not null check (event_type ~ '^[a-z][a-z0-9_]{2,63}$'),
  schema_version integer not null check (schema_version >= 1),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('system', 'user', 'admin', 'webhook', 'job')),
  actor_id text,
  user_id uuid,
  production_id text,
  request_id text,
  master_id text,
  provider text,
  source text not null check (char_length(source) between 1 and 80),
  provenance text not null check (provenance in ('observed_live', 'derived_from_canonical_record')),
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 300),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$')
);
create index if not exists business_events_type_occurred_idx on public.business_events (event_type, occurred_at desc);
create index if not exists business_events_user_idx on public.business_events (user_id) where user_id is not null;
create index if not exists business_events_production_idx on public.business_events (production_id) where production_id is not null;
create index if not exists business_events_recorded_idx on public.business_events (recorded_at desc);
alter table public.business_events enable row level security;
revoke all on public.business_events from anon, authenticated;
drop trigger if exists business_events_append_only on public.business_events;
create trigger business_events_append_only before update or delete on public.business_events for each row execute function public.bt_append_only();

create table if not exists public.business_event_rejections (
  id bigint generated always as identity primary key,
  rejected_at timestamptz not null default now(),
  event_type text,
  reason text not null check (reason in ('unknown_event_type', 'invalid_schema', 'invalid_currency', 'forbidden_metadata', 'secret_like_value', 'missing_provenance', 'missing_reference', 'invalid_timestamp', 'invalid_actor', 'schema_version_mismatch', 'idempotency_conflict', 'persistence_failure')),
  detail text not null check (char_length(detail) <= 300),
  -- only a hash of the key: the refused payload is never stored
  idempotency_key_hash text check (idempotency_key_hash is null or idempotency_key_hash ~ '^[a-f0-9]{32}$'),
  source text
);
create index if not exists business_event_rejections_rejected_idx on public.business_event_rejections (rejected_at desc);
alter table public.business_event_rejections enable row level security;
revoke all on public.business_event_rejections from anon, authenticated;
drop trigger if exists business_event_rejections_append_only on public.business_event_rejections;
create trigger business_event_rejections_append_only before update or delete on public.business_event_rejections for each row execute function public.bt_append_only();

create table if not exists public.business_attribution_touches (
  touch_id text primary key check (touch_id ~ '^att_[a-f0-9]{32}$'),
  visitor_id text not null check (visitor_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  user_id uuid,
  touched_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  -- path only, never a query string (could carry tokens)
  landing_page text check (landing_page is null or (landing_page ~ '^/' and landing_page !~ '[?#]' and char_length(landing_page) <= 300)),
  utm_source text check (utm_source is null or char_length(utm_source) <= 200),
  utm_medium text check (utm_medium is null or char_length(utm_medium) <= 200),
  utm_campaign text check (utm_campaign is null or char_length(utm_campaign) <= 200),
  utm_content text check (utm_content is null or char_length(utm_content) <= 200),
  utm_term text check (utm_term is null or char_length(utm_term) <= 200),
  gclid text check (gclid is null or gclid ~ '^[A-Za-z0-9_.-]{1,200}$'),
  fbclid text check (fbclid is null or fbclid ~ '^[A-Za-z0-9_.-]{1,200}$'),
  source text not null check (char_length(source) between 1 and 80),
  provenance text not null default 'observed_live' check (provenance = 'observed_live'),
  constraint business_attribution_touches_has_data check (landing_page is not null or utm_source is not null or utm_medium is not null or utm_campaign is not null or utm_content is not null or utm_term is not null or gclid is not null or fbclid is not null)
);
create index if not exists business_attribution_touches_visitor_idx on public.business_attribution_touches (visitor_id, touched_at);
create index if not exists business_attribution_touches_user_idx on public.business_attribution_touches (user_id) where user_id is not null;
alter table public.business_attribution_touches enable row level security;
revoke all on public.business_attribution_touches from anon, authenticated;
drop trigger if exists business_attribution_touches_append_only on public.business_attribution_touches;
create trigger business_attribution_touches_append_only before update or delete on public.business_attribution_touches for each row execute function public.bt_append_only();
