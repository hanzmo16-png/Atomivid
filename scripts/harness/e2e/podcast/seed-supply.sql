-- SOLO base local del arnés (puerto 55532). Política ElevenLabs contra el mock; USD 0.
insert into public.pi_supply_policies(provider,enabled,unit,baseline,unit_cost_usd,daily_forecast,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls,free_daily_cap_usd,timezone,evidence)
values ('elevenlabs',true,'character',1000000,0.0001,1000,50,200,50,5000,0,'America/Cancun','arnés local E2E: mock ElevenLabs, USD 0')
on conflict (provider) do update set enabled=true,unit='character',baseline=1000000,unit_cost_usd=0.0001,daily_forecast=1000,daily_cap_usd=50,monthly_cap_usd=200,max_concurrent=50,max_daily_calls=5000,evidence=excluded.evidence;
update public.pi_supply_policies set daily_cap_usd=200, monthly_cap_usd=1000 where provider='__global__';
