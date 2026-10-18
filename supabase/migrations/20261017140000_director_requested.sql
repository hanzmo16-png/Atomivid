-- T-34 B3: the web records whether THIS attempt requested the Director (review rule: render switch + pilot account
-- + visual Reel). The worker reads it before reserving or paying: requested but not applicable in the worker blocks
-- with an explicit message instead of a silent classic montage; not requested never uses the Director.
-- Written only by the server route (service role); browser roles keep no insert/update grant on video_requests.
-- Apply BEFORE deploying the web/worker code that reads or writes the column.
set local lock_timeout = '3s';

alter table public.video_requests
  add column if not exists director_requested boolean not null default false;

comment on column public.video_requests.director_requested is
  'T-34 B3: Director requested by the web for the current attempt; the worker blocks before spending if it cannot apply it.';
