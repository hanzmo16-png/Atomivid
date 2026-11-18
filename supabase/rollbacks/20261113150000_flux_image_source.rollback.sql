-- Reversión de 20261113150000_flux_image_source.sql (FLUX). Segura e idempotente.
-- Se NIEGA a ejecutarse si existe algún video con reel_image_source='flux' (no se borra ni altera ningún dato de usuario).
-- Restaura el CHECK anterior ('default','recraft') y retira la política de suministro y la cuenta de proveedor 'flux'
-- SOLO si siguen cerradas/sin uso (política enabled=false; cuenta sin lecturas en pi_capacity_snapshots).
set local lock_timeout = '3s';
do $$
begin
  if exists (select 1 from public.video_requests where reel_image_source = 'flux') then
    raise exception 'Rollback FLUX abortado: hay videos con reel_image_source=flux (no se modifican datos de usuario).';
  end if;
end $$;
alter table public.video_requests drop constraint video_requests_reel_image_source_valid;
alter table public.video_requests add constraint video_requests_reel_image_source_valid
  check (reel_image_source is null or (mode in ('visual', 'long_form') and reel_image_source in ('default','recraft')));
delete from public.pi_supply_policies where provider = 'flux' and enabled = false;
do $$
declare used boolean := false;
begin
  if to_regclass('public.pi_capacity_snapshots') is not null then
    execute 'select exists (select 1 from public.pi_capacity_snapshots where provider = ''flux'')' into used;
  end if;
  if not used then delete from public.pi_provider_accounts where provider = 'flux'; end if;
end $$;
