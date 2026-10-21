-- unit=usd ⇒ unit_cost_usd=1 (con 0.04 cada imagen consumiría 1 «unidad» de un sobre medido en USD → SUPPLY_ENVELOPE_EXHAUSTED en la 2.ª imagen; visto en R7).
-- SOLO arnés local (127.0.0.1): abre la política «recraft» con topes LOCALES para el ensayo simulado. Nunca producción.
insert into public.pi_supply_policies(provider, unit, evidence) values ('recraft','usd','arnés local') on conflict (provider) do nothing;
update public.pi_supply_policies set enabled=true, baseline=25, unit_cost_usd=1, daily_forecast=1, daily_cap_usd=20, monthly_cap_usd=50, max_concurrent=4, max_daily_calls=500, evidence='arnés local E2E USD 0 (fal simulado)' where provider='recraft';
insert into public.pi_capacity_snapshots(provider,unit,available,reserved,pending,health,reliability,status,checked_at) values ('recraft','usd',25,0,0,'OK','manual_entry','GREEN',now());
