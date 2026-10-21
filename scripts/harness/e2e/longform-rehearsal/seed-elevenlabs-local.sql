-- SOLO arnés local (127.0.0.1): habilita el proveedor de voz con saldo manual para el ensayo Long Form. Nunca producción.
update public.pi_supply_policies set enabled=true, baseline=100000, unit_cost_usd=0.00005, daily_forecast=1, daily_cap_usd=5, monthly_cap_usd=20, max_concurrent=10, max_daily_calls=1000, evidence='arnés local E2E USD 0 (voz fixture)' where provider='elevenlabs';
insert into public.pi_capacity_snapshots(provider,unit,available,reserved,pending,health,reliability,status,checked_at) values ('elevenlabs','character',100000,0,0,'OK','manual_entry','GREEN',now());
-- Topes LOCALES ampliados para ensayos repetidos (el tope diario 5 USD del arnés rechazó correctamente el 2º intento).
update public.pi_supply_policies set daily_cap_usd=60, monthly_cap_usd=200 where provider in ('__global__','openai','elevenlabs');
