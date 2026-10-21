-- Registro del proveedor «recraft» (fal.ai) para que el observador de saldo pueda guardar sus lecturas.
-- Sin esta fila, pi_capacity_snapshots.provider (FK → pi_provider_accounts) rechaza toda lectura de Recraft y el monitor falla con
-- SUPPLY_MONITOR_RECRAFT_SNAPSHOT_UNAVAILABLE: la capacidad queda sin verificar y Recraft no puede pasar la comprobación previa.
-- Solo el NOMBRE del secreto; no inventa saldo, plan ni estado. Requiere 20261021090000_reel_recraft_images.sql.
insert into public.pi_provider_accounts(provider, production_account_label, plan, secret_reference_name, status, balance_source)
values ('recraft', 'ATOMIVID fal.ai account (account verification pending)', 'unverified', 'FAL_ADMIN_KEY', 'unknown', 'provider_api')
on conflict (provider) do nothing;
