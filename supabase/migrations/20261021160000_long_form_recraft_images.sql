-- «Imágenes IA con Recraft» for Long Form (YouTube 16:9). Requires 20261021090000_reel_recraft_images.sql.
-- Reuses the same three columns (historically named reel_*): reel_image_source, reel_recraft_style, reel_recraft_style_id.
-- A Reel chooses at creation (insert). A Long Form row is created by the script job, so its choice is written once
-- by the server in the SAME conditional update that confirms the production plan, and is immutable afterwards.
-- No new tables, no grants changed (server-only writes, as before).
set local lock_timeout = '3s';

alter table public.video_requests drop constraint video_requests_reel_image_source_valid;
alter table public.video_requests add constraint video_requests_reel_image_source_valid
  check (reel_image_source is null or (mode in ('visual', 'long_form') and reel_image_source in ('default','recraft')));

comment on column public.video_requests.reel_image_source is 'Per-video image source: null/default = existing behaviour, recraft = Recraft V4 Styles via fal.ai. Reel: set at creation. Long Form: set once with the plan confirmation. Immutable afterwards.';

create or replace function public.reel_recraft_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.reel_image_source is distinct from old.reel_image_source
     or new.reel_recraft_style is distinct from old.reel_recraft_style then
    -- Only allowed transition: a Long Form without a choice gets one in the very update that confirms its plan.
    if not (old.mode = 'long_form' and old.long_form_confirmed_at is null and new.long_form_confirmed_at is not null
            and old.reel_image_source is null and old.reel_recraft_style is null) then
      raise exception 'reel image source is immutable';
    end if;
  end if;
  if old.reel_recraft_style_id is not null and new.reel_recraft_style_id is distinct from old.reel_recraft_style_id then
    raise exception 'reel recraft style id is immutable once set';
  end if;
  return new;
end;
$$;
revoke all on function public.reel_recraft_immutable() from public, anon, authenticated;
