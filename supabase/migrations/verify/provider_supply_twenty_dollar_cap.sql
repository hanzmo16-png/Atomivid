-- Execute inside BEGIN/ROLLBACK; fictional account only, no provider calls.
insert into public.pi_provider_accounts(provider,production_account_label,plan,secret_reference_name,status,balance_source)
values ('supply-cap-fixture','rollback-only simulation','fixture','SUPPLY_TEST_KEY','unknown','none');
insert into public.pi_supply_policies(provider,enabled,unit,baseline,unit_cost_usd,daily_forecast,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls,evidence)
values ('supply-cap-fixture',true,'usd',1000,1,0,20,100,10,100,'ROLLBACK ONLY');
update public.pi_supply_policies set enabled=true,daily_cap_usd=100000,monthly_cap_usd=100000,evidence='ROLLBACK ONLY' where provider='__global__';
insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at)
values('supply-cap-fixture','usd',1000,'OK','provider_api','GREEN',clock_timestamp());
insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status)
values ('cap-first','cap-fixture','first','supply-cap-fixture','fixture','simulation','initial',19.5,'RESERVED'),
('cap-over','cap-fixture-other','over','supply-cap-fixture','fixture','simulation','initial',0.51,'RESERVED'),
('cap-last','cap-fixture-last','last','supply-cap-fixture','fixture','simulation','initial',0.5,'RESERVED');
do $$ declare r jsonb; begin
 r:=public.pi_submit_with_supply('cap-first',19.5); assert (r->>'submitted')::boolean;
 update public.pi_paid_operations set status='RECONCILIATION_REQUIRED' where idempotency_key='cap-first';
 r:=public.pi_submit_with_supply('cap-over',0.51); assert r->>'reason'='provider funded spend ceiling','uncertain charge stopped counting toward $20';
 r:=public.pi_submit_with_supply('cap-last',0.5); assert (r->>'submitted')::boolean,'exact $20 boundary should fit';
 r:=public.pi_submit_with_supply('cap-over',0.51); assert r->>'reason'='provider funded spend ceiling';
 assert (select status from public.pi_paid_operations where idempotency_key='cap-over')='RESERVED','denied operation submitted';
end $$;
select 'PASS: $19.50 uncertain + $0.50 reserved fills $20 daily cap; $0.51 blocked before provider call' as result;
