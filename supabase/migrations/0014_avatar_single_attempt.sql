-- Durable claim made before any voice/video provider consumption.
-- Deliberately retained on failures: a timeout is not evidence of no charge.
-- Existing jobs are also excluded by the pipeline compare-and-set.
alter table public.video_requests
  add column if not exists avatar_generation_started_at timestamptz;
