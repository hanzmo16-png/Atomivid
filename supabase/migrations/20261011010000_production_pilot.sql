-- Supervised production pilot on the podcast flow (additive). The owner sets a maximum budget per production and
-- may schedule its start; the worker produces in the background and leaves a reviewable delivery or a clear block.
-- Publication stays held until the owner approves; technical checks are stored apart from the creative decision.
set local lock_timeout = '3s';

alter table public.podcast_episodes drop constraint if exists podcast_episodes_video_status_check;
alter table public.podcast_episodes add constraint podcast_episodes_video_status_check
  check (video_status in ('none','scheduled','queued','running','ready','failed','blocked'));

alter table public.podcast_episodes
  -- Maximum the owner accepts to spend on this production (narration; the video uses free-licence stock).
  add column if not exists budget_usd numeric(12,4) check (budget_usd is null or (budget_usd >= 0 and budget_usd <= 100)),
  -- One-shot scheduled start (never recurring); picked up by the worker's scheduled tick.
  add column if not exists scheduled_at timestamptz,
  -- Technical checks and detected defects of the delivered video (computed by the worker, no paid call).
  add column if not exists video_checks jsonb,
  -- Creative review: pending until the owner approves or rejects. A new production resets it.
  add column if not exists review_status text not null default 'pending' check (review_status in ('pending','approved','rejected')),
  add column if not exists review_note text check (review_note is null or length(review_note) <= 1000),
  add column if not exists reviewed_at timestamptz,
  -- Publication is held until approval; with no upload integration an approved video is published manually.
  add column if not exists publish_status text not null default 'held' check (publish_status in ('held','manual'));

create index if not exists podcast_episodes_scheduled_idx on public.podcast_episodes (scheduled_at)
  where video_status = 'scheduled';

-- Owner notices (delivery, block, insufficient budget): one per production run and kind, never one per step.
create table if not exists public.production_notices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  episode_id uuid not null references public.podcast_episodes(id) on delete cascade,
  kind text not null check (kind in ('delivered','blocked','budget')),
  run_key text not null check (length(run_key) between 1 and 80),
  message text not null check (length(message) <= 500),
  channel text check (channel is null or channel in ('github')),
  delivered_at timestamptz,
  delivery_error text check (delivery_error is null or length(delivery_error) <= 300),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (episode_id, kind, run_key)
);
alter table public.production_notices enable row level security;
drop policy if exists "owner reads own notices" on public.production_notices;
create policy "owner reads own notices" on public.production_notices for select using (auth.uid() = user_id);
create index if not exists production_notices_user_idx on public.production_notices (user_id, created_at desc);
