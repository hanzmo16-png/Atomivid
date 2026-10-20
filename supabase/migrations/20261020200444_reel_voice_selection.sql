-- Apply before deploying the new worker. NULL preserves every existing request's default voice.
alter table public.video_requests add column reel_voice_id text;
alter table public.video_requests add constraint video_requests_reel_voice_id_valid
  check (reel_voice_id is null or (mode is not distinct from 'visual' and reel_voice_id ~ '^[A-Za-z0-9]{8,64}$'));
comment on column public.video_requests.reel_voice_id is
  'Server-validated Reel voice chosen at creation; null uses the legacy language default. Immutable.';

-- The server already owns all writes (20261009040743). Lock voice identity even for service writers:
-- editing/recovering a script or retrying a render cannot silently change what the customer chose.
create function public.reel_voice_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.reel_voice_id is distinct from old.reel_voice_id then
    raise exception 'reel voice is immutable';
  end if;
  return new;
end;
$$;
revoke all on function public.reel_voice_immutable() from public, anon, authenticated;
create trigger reel_voice_immutable before update on public.video_requests
for each row execute function public.reel_voice_immutable();
