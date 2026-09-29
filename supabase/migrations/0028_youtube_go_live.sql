-- YouTube read-only go-live: idempotent performance snapshots (T+24h/48h/7d/28d), launch
-- records (prepared by ATOMIVID, published MANUALLY by a person), and a read-only view that
-- joins a linked video with its master's Final Cut metrics for later human comparison.
-- Additive over 0024/0026/0027. No publish capability. Service-role writes; owners read theirs.

create table if not exists public.yt_performance_snapshots (
  snapshot_key text primary key,
  channel_id text not null references public.yt_channels (channel_id) on delete cascade,
  video_id text not null check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  "window" text not null check ("window" in ('24h','48h','7d','28d')),
  due_at timestamptz not null,
  status text not null check (status in ('NOT_DUE','PENDING','COLLECTED','PARTIAL','UNAVAILABLE')),
  collected_at timestamptz,
  metrics jsonb not null default '{}',
  source text check (source is null or source in ('youtube-analytics-v2','youtube-data-v3')),
  last_failure text,
  attempts integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (channel_id, video_id, "window"),
  constraint yt_snapshot_collected_has_time check (status not in ('COLLECTED','PARTIAL') or collected_at is not null)
);

-- A COLLECTED snapshot is final: it is never re-collected or rewritten.
create or replace function public.yt_snapshot_final() returns trigger language plpgsql as $$
begin
  if old.status = 'COLLECTED' and (new.status <> 'COLLECTED' or new.metrics <> old.metrics) then raise exception 'a COLLECTED snapshot is immutable (%)', old.snapshot_key; end if;
  return new;
end $$;
drop trigger if exists yt_performance_snapshots_final on public.yt_performance_snapshots;
create trigger yt_performance_snapshots_final before update on public.yt_performance_snapshots for each row execute function public.yt_snapshot_final();

create table if not exists public.yt_launch_records (
  launch_id text primary key,
  production_id text not null,
  master_id text not null,
  master_hash text not null check (master_hash ~ '^[a-f0-9]{64}$'),
  master_storage_path text not null check (master_storage_path !~ '[?&]token=' and master_storage_path !~* '^https?://'),
  final_cut_status text not null check (final_cut_status in ('EDITORIAL_QA_PASS','FINAL_CUT_DISABLED')),
  final_cut_report_id text,
  title text not null,
  description text not null default '',
  chapters jsonb not null default '[]',
  language text not null,
  thumbnail_reference text,
  visibility_intent text not null check (visibility_intent in ('private','unlisted','public')),
  channel_id text not null references public.yt_channels (channel_id) on delete cascade,
  youtube_video_id text check (youtube_video_id is null or youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'),
  published_at timestamptz,
  published_by text,
  status text not null check (status in ('PREPARED','PUBLISHED_MANUALLY')),
  created_at timestamptz not null default now(),
  -- A manual publication always names the person and the video.
  constraint yt_launch_published_consistent check ((status = 'PUBLISHED_MANUALLY') = (youtube_video_id is not null and published_by is not null and published_at is not null))
);

-- Read-only join for the three-video comparison (no learning, no writes).
create or replace view public.yt_video_experiment as
select l.project_id as production_id, l.channel_id, l.video_id, l.published_at, l.master_checksum_sha256,
       s."window", s.status as snapshot_status, s.metrics as youtube_metrics, s.collected_at,
       m.master_id, m.report_id as final_cut_report_id, m.metrics as final_cut_metrics
from public.yt_video_links l
left join public.yt_performance_snapshots s on s.channel_id = l.channel_id and s.video_id = l.video_id
left join public.fc_master_metrics m on m.production_id = l.project_id
where l.status = 'linked';

alter table public.yt_performance_snapshots enable row level security;
alter table public.yt_launch_records enable row level security;
drop policy if exists "owner reads own snapshots" on public.yt_performance_snapshots;
create policy "owner reads own snapshots" on public.yt_performance_snapshots for select using (exists (select 1 from public.yt_channels c where c.channel_id = yt_performance_snapshots.channel_id and c.owner_user_id = auth.uid()));
drop policy if exists "owner reads own launch records" on public.yt_launch_records;
create policy "owner reads own launch records" on public.yt_launch_records for select using (exists (select 1 from public.yt_channels c where c.channel_id = yt_launch_records.channel_id and c.owner_user_id = auth.uid()));
