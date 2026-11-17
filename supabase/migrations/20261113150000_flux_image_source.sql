-- «Imágenes IA con FLUX» (FLUX.1 [dev] via fal.ai): the SECOND selectable image provider for Reel and Long Form.
-- Requires 20261021160000_long_form_recraft_images.sql (current form of the constraint and of the immutability trigger).
-- Additive and compatible with the code deployed before the merge (it never writes 'flux').
-- 1) reel_image_source also accepts 'flux'. FLUX has no per-video style: the style/style_id constraints already force
--    reel_recraft_style and reel_recraft_style_id to stay NULL for any source other than 'recraft'. The existing trigger
--    keeps the choice immutable (Reel: set at creation; Long Form: only in the update that confirms the plan).
-- 2) Supply policy `flux` starts CLOSED (enabled=false, caps 0), like every provider: nothing can be paid until the
--    owner enables it with funded caps and evidence. Not a payment, credit or budget change.
-- 3) Provider account row (FK of pi_capacity_snapshots) so the balance observer can store FLUX readings: only the NAME of
--    the secret; no balance, plan or state is invented.
set local lock_timeout = '3s';

alter table public.video_requests drop constraint video_requests_reel_image_source_valid;
alter table public.video_requests add constraint video_requests_reel_image_source_valid
  check (reel_image_source is null or (mode in ('visual', 'long_form') and reel_image_source in ('default','recraft','flux')));

comment on column public.video_requests.reel_image_source is 'Per-video image source: null/default = existing behaviour, recraft = Recraft V4 Styles via fal.ai, flux = FLUX.1 [dev] via fal.ai. Reel: set at creation. Long Form: set once with the plan confirmation. Immutable afterwards.';

insert into public.pi_supply_policies(provider, unit, evidence)
values ('flux', 'usd', 'fal.ai fal-ai/flux/dev: USD 0.025 por megapíxel, redondeado al megapíxel; 720x1280 o 1280x720 = USD 0.025/imagen (fal.ai, 2026-11-13)')
on conflict (provider) do nothing;

insert into public.pi_provider_accounts(provider, production_account_label, plan, secret_reference_name, status, balance_source)
values ('flux', 'ATOMIVID fal.ai account (account verification pending)', 'unverified', 'FAL_ADMIN_KEY', 'unknown', 'provider_api')
on conflict (provider) do nothing;
