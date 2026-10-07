insert into public.pi_provider_accounts(provider,production_account_label,plan,secret_reference_name,status,balance_source)
values ('supply-fixture','rollback-only simulation','fixture','SUPPLY_TEST_KEY','unknown','none');
insert into public.pi_supply_policies(provider,enabled,unit,baseline,unit_cost_usd,daily_forecast,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls,evidence)
values ('supply-fixture',true,'usd',1000,1,0,100,100,3,100,'ROLLBACK ONLY fixture evidence');
update public.pi_supply_policies set enabled=true,daily_cap_usd=100000,monthly_cap_usd=100000,evidence='ROLLBACK ONLY fixture ceiling' where provider='__global__';
insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at) values('supply-fixture','usd',1000,'OK','provider_api','GREEN',clock_timestamp());
insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,capacity_units)
select 'supply-fixture-'||n,'supply-fixture','s'||n,'supply-fixture','fixture','simulation','initial',1,'RESERVED',1 from generate_series(1,50)n;
do $$
declare r jsonb; n int; admitted int:=0; denied int:=0; s jsonb;
begin
 for n in 1..50 loop
  r:=public.pi_submit_with_supply('supply-fixture-'||n,1);
  if (r->>'submitted')::boolean then admitted:=admitted+1;
  elsif r->>'reason'='concurrency' then denied:=denied+1;
  else raise exception 'unexpected supply decision: %',r; end if;
 end loop;
 assert admitted=3 and denied=47, 'concurrency admission overbooked';
 update public.pi_paid_operations set status='COMMITTED',committed_usd=1 where provider='supply-fixture' and status='SUBMITTED';
 for n in 4..50 loop
  r:=public.pi_submit_with_supply('supply-fixture-'||n,1);
  assert (r->>'submitted')::boolean, 'reserved queue operation did not resume';
  update public.pi_paid_operations set status='COMMITTED',committed_usd=1 where idempotency_key='supply-fixture-'||n;
 end loop;
 s:=public.pi_supply_state('supply-fixture');
 assert (s->>'free')::numeric=950, 'consumption was lost or counted twice';
 r:=public.pi_submit_with_supply('supply-fixture-1',1);
 assert r->>'reason'='already_claimed','completed operation submitted twice';
 update public.pi_supply_policies set daily_cap_usd=50 where provider='supply-fixture';
 insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status)
 values('supply-fixture-limit','supply-fixture','s-limit','supply-fixture','fixture','simulation','initial',1,'RESERVED');
 r:=public.pi_submit_with_supply('supply-fixture-limit',1);
 assert r->>'reason'='provider funded spend ceiling','daily ceiling not enforced';
 update public.pi_supply_policies set daily_cap_usd=100 where provider='supply-fixture';
 insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,supply_pool)
 values('supply-fixture-free','supply-fixture','s-free','supply-fixture','fixture','simulation','initial',1,'RESERVED','free');
 r:=public.pi_submit_with_supply('supply-fixture-free',1);
 assert r->>'reason'='free pool closed','unfunded free generation permitted';
 insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at) values('supply-fixture','usd',50,'OK','provider_api','GREEN',clock_timestamp()+interval '1 second');
 s:=public.pi_supply_state('supply-fixture');
 assert s->>'level'='UNKNOWN','future balance admitted';
end $$;
select 'PASS: 50 admissions, 3 concurrent slots, safe queue resumption, exact debit, no duplicate submit, daily cap, free pool closed, invalid snapshot blocked; zero provider calls' as result;
