-- Configuración LOCAL del arnés (no producción): presupuesto controlado y saldo manual para el proveedor de guion mock.
insert into public.pi_supply_policies(provider,enabled,unit,baseline,unit_cost_usd,daily_forecast,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls,free_daily_cap_usd,timezone,evidence)
values ('__global__',true,'usd',100,1,1,5,20,10,1000,0,'America/Cancun','arnés local E2E USD 0'),
       ('anthropic',true,'usd',100,1,1,5,20,10,1000,0,'America/Cancun','arnés local E2E USD 0 (mock loopback)')
on conflict (provider) do update set enabled=excluded.enabled, unit=excluded.unit, baseline=excluded.baseline, unit_cost_usd=excluded.unit_cost_usd, daily_forecast=excluded.daily_forecast, daily_cap_usd=excluded.daily_cap_usd, monthly_cap_usd=excluded.monthly_cap_usd, max_concurrent=excluded.max_concurrent, max_daily_calls=excluded.max_daily_calls, timezone=excluded.timezone, evidence=excluded.evidence;
insert into public.pi_capacity_snapshots(provider,unit,available,reserved,pending,health,reliability,status,checked_at)
values ('anthropic','usd',100,0,0,'OK','manual_entry','GREEN',now());
insert into public.pi_supply_policies(provider,enabled,unit,baseline,unit_cost_usd,daily_forecast,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls,free_daily_cap_usd,timezone,evidence)
values ('openai',true,'usd',100,1,1,5,20,10,1000,0,'America/Cancun','arnés local E2E USD 0 (mock OpenAI Images loopback)')
on conflict (provider) do update set enabled=excluded.enabled, unit=excluded.unit, baseline=excluded.baseline, unit_cost_usd=excluded.unit_cost_usd, daily_forecast=excluded.daily_forecast, daily_cap_usd=excluded.daily_cap_usd, monthly_cap_usd=excluded.monthly_cap_usd, max_concurrent=excluded.max_concurrent, max_daily_calls=excluded.max_daily_calls, timezone=excluded.timezone, evidence=excluded.evidence;
insert into public.pi_capacity_snapshots(provider,unit,available,reserved,pending,health,reliability,status,checked_at)
values ('openai','usd',100,0,0,'OK','manual_entry','GREEN',now());
