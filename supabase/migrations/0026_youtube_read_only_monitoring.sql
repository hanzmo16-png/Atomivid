-- YouTube READ-ONLY monitoring (Distribution Intelligence V1, second slice), additive over 0024:
-- production <-> YouTube video links, channel snapshots (time series), pending OAuth state
-- (PKCE verifier, short-lived), traffic-source labels and manual Studio-only metrics.
-- No publish/upload/delete capability is added. Service-role writes only; owners read their own.
-- Nothing is dropped except a CHECK constraint that is re-created wider in the same statement group.

create table if not exists public.yt_video_links (
  link_key text primary key,
  project_id text not null,
  request_id text,
  master_checksum_sha256 text not null check (master_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  master_storage_path text not null check (master_storage_path !~ '[?&]token=' and master_storage_path !~* '^https?://'),
  channel_id text not null references public.yt_channels (channel_id) on delete cascade,
  video_id text not null check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  published_at timestamptz,
  linked_at timestamptz not null,
  linked_by text not null,
  status text not null check (status in ('linked','unlinked')),
  unique (project_id, video_id)
);
create index if not exists yt_video_links_channel_idx on public.yt_video_links (channel_id, status);

create table if not exists public.yt_channel_snapshots (
  snapshot_key text primary key,
  channel_id text not null references public.yt_channels (channel_id) on delete cascade,
  collected_at timestamptz not null,
  subscribers bigint,
  total_views bigint,
  video_count integer,
  watch_time_minutes double precision,
  window_start date,
  window_end date,
  uploads_playlist_id text
);
create index if not exists yt_channel_snapshots_series_idx on public.yt_channel_snapshots (channel_id, collected_at);

-- Pending consent: PKCE verifier + state, consumed once by the callback. No token here.
create table if not exists public.yt_pending_connections (
  state text primary key,
  code_verifier text not null,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  connection_id text not null unique,
  created_at timestamptz not null default now()
);

alter table public.yt_metric_rows add column if not exists dimension_label text;

-- Widen the metric / source domains (additive: every previously legal value stays legal).
alter table public.yt_metric_rows drop constraint if exists yt_metric_rows_metric_check;
alter table public.yt_metric_rows add constraint yt_metric_rows_metric_check
  check (metric in ('views','watchTimeMinutes','averageViewDurationSeconds','likes','comments','shares','subscribersGained','subscribersLost','audienceWatchRatio','averagePercentageViewed','impressions','impressionsCtr'));
alter table public.yt_metric_rows drop constraint if exists yt_metric_rows_source_check;
alter table public.yt_metric_rows add constraint yt_metric_rows_source_check
  check (source in ('youtube-analytics-v2','youtube-data-v3','manual_entry'));
-- Studio-only figures may only come from a person.
alter table public.yt_metric_rows drop constraint if exists yt_metric_rows_manual_only_check;
alter table public.yt_metric_rows add constraint yt_metric_rows_manual_only_check
  check ((metric in ('impressions','impressionsCtr')) = (source = 'manual_entry'));

alter table public.yt_video_links enable row level security;
alter table public.yt_channel_snapshots enable row level security;
alter table public.yt_pending_connections enable row level security;

drop policy if exists "owner reads own video links" on public.yt_video_links;
create policy "owner reads own video links" on public.yt_video_links for select using (exists (select 1 from public.yt_channels c where c.channel_id = yt_video_links.channel_id and c.owner_user_id = auth.uid()));
drop policy if exists "owner reads own channel snapshots" on public.yt_channel_snapshots;
create policy "owner reads own channel snapshots" on public.yt_channel_snapshots for select using (exists (select 1 from public.yt_channels c where c.channel_id = yt_channel_snapshots.channel_id and c.owner_user_id = auth.uid()));
-- No policy on yt_pending_connections: service role only.
