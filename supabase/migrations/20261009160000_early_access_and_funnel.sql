-- Early-access list (documentaries) and first-party funnel measurement. Additive only.
-- Both tables are server-only: RLS on, no client grants. The web app writes through the service role
-- after validating input; nothing here is readable or writable from a browser session.
set local lock_timeout = '3s';

create table if not exists public.early_access_requests (
  id uuid primary key default gen_random_uuid(),
  product text not null check (product in ('documentales')),
  email text not null check (length(email) between 3 and 254 and email = lower(email)),
  user_id uuid references auth.users(id) on delete set null,
  visitor_id uuid,
  source text check (source is null or length(source) <= 64),
  consent_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (product, email)
);
alter table public.early_access_requests enable row level security;
revoke all on public.early_access_requests from public, anon, authenticated;
grant all on public.early_access_requests to service_role;

-- One row per counted event. dedupe_key makes every emitter idempotent (a reload, a double click or a
-- Stripe redelivery cannot count twice). No email, script text, payment detail or credential is stored:
-- only a random visitor id, the account id when known, and the campaign source.
create table if not exists public.marketing_events (
  id bigint generated always as identity primary key,
  event text not null check (event in ('landing_view','cta_click','early_access_joined','signup_completed','checkout_started','payment_confirmed','first_production_completed')),
  dedupe_key text not null unique check (length(dedupe_key) <= 200),
  visitor_id uuid,
  user_id uuid references auth.users(id) on delete set null,
  cta text check (cta is null or cta ~ '^[a-z0-9_]{1,40}$'),
  source text check (source is null or length(source) <= 64),
  medium text check (medium is null or length(medium) <= 64),
  campaign text check (campaign is null or length(campaign) <= 64),
  created_at timestamptz not null default now()
);
create index if not exists marketing_events_event_created on public.marketing_events (event, created_at);
alter table public.marketing_events enable row level security;
revoke all on public.marketing_events from public, anon, authenticated;
grant all on public.marketing_events to service_role;

-- Funnel for a period: counts and distinct people per event, clicks per call to action, list sign-ups.
create or replace function public.marketing_funnel(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'events', coalesce((select jsonb_object_agg(event, jsonb_build_object('count', n, 'people', people)) from (
       select event, count(*) as n, count(distinct coalesce(user_id::text, visitor_id::text)) as people
       from public.marketing_events where created_at >= p_from and created_at < p_to group by event) ev), '{}'::jsonb),
    'cta_clicks', coalesce((select jsonb_object_agg(cta, n) from (select cta, count(*) as n from public.marketing_events
       where event = 'cta_click' and created_at >= p_from and created_at < p_to group by cta) c), '{}'::jsonb),
    'early_access_requests', (select count(*) from public.early_access_requests where created_at >= p_from and created_at < p_to)
  );
$$;
revoke all on function public.marketing_funnel(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.marketing_funnel(timestamptz, timestamptz) to service_role;
