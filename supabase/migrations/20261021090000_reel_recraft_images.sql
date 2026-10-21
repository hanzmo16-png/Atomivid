-- «Imágenes IA con Recraft» (fal.ai) per Reel. PREPARED ONLY: not applied in this delivery.
-- Apply BEFORE deploying the web/worker that writes these columns (the code reads them in a separate query and
-- treats an absent column as «not chosen», so existing Reels keep working either way).
-- No new tables: the Oct 30 2026 Supabase change (new tables need explicit Data API grants) does not apply here;
-- the existing grants of video_requests stay as they are (server-only writes, 20261009040743). Explicit
-- revokes/grants are stated below for the new function and the existing policy table.
set local lock_timeout = '3s';

alter table public.video_requests
  add column reel_image_source text,
  add column reel_recraft_style jsonb,
  add column reel_recraft_style_id text;

alter table public.video_requests add constraint video_requests_reel_image_source_valid
  check (reel_image_source is null or (mode is not distinct from 'visual' and reel_image_source in ('default','recraft')));
alter table public.video_requests add constraint video_requests_reel_recraft_style_valid
  check ((reel_image_source is distinct from 'recraft' and reel_recraft_style is null)
      or (reel_image_source = 'recraft' and jsonb_typeof(reel_recraft_style) = 'object'));
alter table public.video_requests add constraint video_requests_reel_recraft_style_id_valid
  check (reel_recraft_style_id is null or (reel_image_source = 'recraft' and reel_recraft_style_id ~ '^[A-Za-z0-9-]{8,64}$'));

comment on column public.video_requests.reel_image_source is 'Per-Reel image source chosen at creation: null/default = existing behaviour, recraft = Recraft V4 Styles via fal.ai. Immutable.';
comment on column public.video_requests.reel_recraft_style is 'User style choice for this Reel: {styleId|null, referencePaths[], match, styleNote}. Immutable.';
comment on column public.video_requests.reel_recraft_style_id is 'Recraft style_id used for every scene; set once (null -> value) by the worker after fal returns it.';

create function public.reel_recraft_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.reel_image_source is distinct from old.reel_image_source
     or new.reel_recraft_style is distinct from old.reel_recraft_style then
    raise exception 'reel image source is immutable';
  end if;
  if old.reel_recraft_style_id is not null and new.reel_recraft_style_id is distinct from old.reel_recraft_style_id then
    raise exception 'reel recraft style id is immutable once set';
  end if;
  return new;
end;
$$;
revoke all on function public.reel_recraft_immutable() from public, anon, authenticated;
create trigger reel_recraft_immutable before update on public.video_requests
for each row execute function public.reel_recraft_immutable();

-- Supply policy for the new provider: starts CLOSED (enabled=false, caps 0) like every other provider. The owner
-- enables it with funded caps and evidence only when a budget is authorized. Not a payment or credit change.
insert into public.pi_supply_policies(provider, unit, evidence)
values ('recraft', 'usd', 'fal.ai recraft/v4/style/text-to-image: USD 0.035/imagen con style_id; +0.005 al crear estilo (fal.ai, 2026-10-21)')
on conflict (provider) do nothing;
revoke all on public.pi_supply_policies from anon, authenticated;
grant all on public.pi_supply_policies to service_role;
