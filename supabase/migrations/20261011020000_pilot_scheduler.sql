-- Supervised pilot: reliable one-shot scheduled starts. GitHub's scheduled workflows run hours late on this
-- repository (supply-observe, hourly, runs every 4-6 h), so the database checks every minute whether a scheduled
-- production is due and, only then, calls the app, which claims it (compare-and-set) and dispatches the worker.
-- The call is authenticated by a random token that lives only in this service-role table (read by the app with the
-- service key); nothing else is exposed. No production is ever created here.
set local lock_timeout = '3s';
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create table if not exists public.pilot_scheduler_secret (
  id integer primary key default 1 check (id = 1),
  token text not null check (length(token) >= 48)
);
alter table public.pilot_scheduler_secret enable row level security;
revoke all on public.pilot_scheduler_secret from anon, authenticated;
insert into public.pilot_scheduler_secret (id, token)
  values (1, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (id) do nothing;

create or replace function public.pilot_scheduler_tick() returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if exists (select 1 from public.podcast_episodes where video_status = 'scheduled' and scheduled_at <= now()) then
    perform net.http_post(
      url := 'https://atomivid.vercel.app/api/cron/podcast-schedule',
      headers := jsonb_build_object('content-type', 'application/json', 'x-tick-token', (select token from public.pilot_scheduler_secret where id = 1)),
      body := '{}'::jsonb,
      timeout_milliseconds := 20000);
  end if;
end $$;
revoke all on function public.pilot_scheduler_tick() from public, anon, authenticated;

select cron.schedule('pilot-scheduler-tick', '* * * * *', 'select public.pilot_scheduler_tick()');
