-- Distribution Intelligence V1 (YouTube foundation): channels, encrypted OAuth
-- envelopes, idempotent analytics rows, per-channel observations and launch packages.
-- Tokens are never readable by clients (RLS on, no policy). Owners may read their
-- own channels' data; all writes happen server-side with the service role.

create table if not exists public.yt_channels (
  channel_id text primary key check (channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  connection_id text not null unique,
  title text not null default '',
  language text not null,
  niche text not null default '',
  timezone text not null default 'UTC',
  distribution_profile text not null default 'default',
  connected_at timestamptz,
  status text not null check (status in ('pending','connected','revoked','error')),
  created_at timestamptz not null default now()
);
create index if not exists yt_channels_owner_idx on public.yt_channels (owner_user_id);

-- Encrypted refresh-token envelope (AES-256-GCM "v1.iv.tag.ciphertext"); never plaintext.
create table if not exists public.yt_oauth_connections (
  connection_id text primary key references public.yt_channels (connection_id) on delete cascade,
  refresh_token_enc text not null check (refresh_token_enc like 'v1.%'),
  scopes text[] not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists public.yt_metric_rows (
  row_key text primary key,
  channel_id text not null references public.yt_channels (channel_id) on delete cascade,
  video_id text not null,
  metric text not null check (metric in ('views','watchTimeMinutes','averageViewDurationSeconds','likes','comments','shares','subscribersGained','subscribersLost','audienceWatchRatio')),
  value double precision not null,
  dimension_value double precision,
  window_start date not null,
  window_end date not null check (window_end >= window_start),
  source text not null check (source in ('youtube-analytics-v2','youtube-data-v3')),
  collected_at timestamptz not null
);
create index if not exists yt_metric_rows_video_idx on public.yt_metric_rows (channel_id, video_id);

create table if not exists public.yt_video_observations (
  channel_id text not null references public.yt_channels (channel_id) on delete cascade,
  video_id text not null,
  published_at timestamptz,
  topic text,
  title_structure text,
  thumbnail_metadata jsonb,
  duration_seconds numeric,
  hook_structure text,
  observed_at timestamptz not null default now(),
  primary key (channel_id, video_id)
);

create table if not exists public.yt_launch_packages (
  id uuid primary key default gen_random_uuid(),
  project_id text not null,
  channel_id text not null references public.yt_channels (channel_id) on delete cascade,
  payload jsonb not null,
  status text not null check (status in ('proposed','approved','rejected')),
  approved_by text,
  approved_at timestamptz,
  constraint yt_launch_approval_consistent check ((status = 'approved') = (approved_by is not null and approved_at is not null)),
  created_at timestamptz not null default now()
);

alter table public.yt_channels enable row level security;
alter table public.yt_oauth_connections enable row level security;
alter table public.yt_metric_rows enable row level security;
alter table public.yt_video_observations enable row level security;
alter table public.yt_launch_packages enable row level security;

-- Owner read access, scoped per channel. No client write policies; no policy at all on tokens.
drop policy if exists "owner reads own channels" on public.yt_channels;
create policy "owner reads own channels" on public.yt_channels for select using (auth.uid() = owner_user_id);
drop policy if exists "owner reads own channel metrics" on public.yt_metric_rows;
create policy "owner reads own channel metrics" on public.yt_metric_rows for select using (exists (select 1 from public.yt_channels c where c.channel_id = yt_metric_rows.channel_id and c.owner_user_id = auth.uid()));
drop policy if exists "owner reads own channel observations" on public.yt_video_observations;
create policy "owner reads own channel observations" on public.yt_video_observations for select using (exists (select 1 from public.yt_channels c where c.channel_id = yt_video_observations.channel_id and c.owner_user_id = auth.uid()));
drop policy if exists "owner reads own launch packages" on public.yt_launch_packages;
create policy "owner reads own launch packages" on public.yt_launch_packages for select using (exists (select 1 from public.yt_channels c where c.channel_id = yt_launch_packages.channel_id and c.owner_user_id = auth.uid()));
