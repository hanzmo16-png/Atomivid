-- Podcast → video inside the app: the worker narrates (if needed) and renders the episode with the editor v3
-- engine, then stores the MP4 next to the audio in the private "videos" bucket. Additive columns only.
set local lock_timeout = '3s';
alter table public.podcast_episodes
  add column if not exists video_status text not null default 'none'
    check (video_status in ('none','queued','running','ready','failed')),
  add column if not exists video_stage text check (video_stage is null or length(video_stage) <= 60),
  add column if not exists video_attempts integer not null default 0 check (video_attempts between 0 and 50),
  add column if not exists video_run_token uuid,
  add column if not exists video_requested_at timestamptz,
  add column if not exists video_heartbeat_at timestamptz,
  add column if not exists video_path text check (video_path is null or length(video_path) <= 400),
  add column if not exists video_bytes bigint check (video_bytes is null or video_bytes > 0),
  add column if not exists video_sha256 text check (video_sha256 is null or video_sha256 ~ '^[0-9a-f]{64}$'),
  add column if not exists video_duration_seconds numeric check (video_duration_seconds is null or video_duration_seconds > 0),
  add column if not exists video_error text check (video_error is null or length(video_error) <= 500);
-- Background narration (long scripts) also uses the worker: it reports progress on the same row.
