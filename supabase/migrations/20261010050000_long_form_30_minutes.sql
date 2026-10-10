-- Long Form up to 30 minutes (1800 s). Same per-mode CHECK as 0018, only the long_form upper bound moves from
-- 900 to 1800. Every existing row (long_form <= 900, others <= 120) already satisfies it: no backfill.
-- Rollback (safe while no long_form row exceeds 900 s): re-run the 0018 constraint.
set local lock_timeout = '3s';
alter table public.video_requests
  drop constraint if exists video_requests_duration_seconds_check;
alter table public.video_requests
  add constraint video_requests_duration_seconds_check
  check (
    (mode = 'long_form' and duration_seconds >= 180 and duration_seconds <= 1800)
    or (mode <> 'long_form' and duration_seconds > 0 and duration_seconds <= 120)
  );
