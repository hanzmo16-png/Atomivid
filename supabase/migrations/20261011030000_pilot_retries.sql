-- Supervised pilot: the retry limit counts consecutive unsuccessful attempts since the last delivery (a new
-- production after a delivered one starts again from zero), not every production of the episode's history.
set local lock_timeout = '3s';
alter table public.podcast_episodes
  add column if not exists retry_count integer not null default 0 check (retry_count between 0 and 50);
