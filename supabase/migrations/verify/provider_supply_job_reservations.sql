-- Run AFTER the migration, inside BEGIN/ROLLBACK. No provider HTTP, real credit or payment.
insert into public.pi_provider_accounts(provider,production_account_label,plan,secret_reference_name,status,balance_source)
values ('supply-job-fixture','rollback-only simulation','fixture','SUPPLY_TEST_KEY','unknown','none');
insert into public.pi_supply_policies(provider,enabled,unit,baseline,unit_cost_usd,daily_forecast,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls,evidence)
values ('supply-job-fixture',true,'usd',1000,1,0,100000,100000,3,1000,'ROLLBACK ONLY evidence');
update public.pi_supply_policies set enabled=true,daily_cap_usd=1000000,monthly_cap_usd=1000000,evidence='ROLLBACK ONLY ceiling' where provider='__global__';
insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at)
values('supply-job-fixture','usd',1000,'OK','provider_api','GREEN',clock_timestamp());
do $$
declare vid uuid; n integer; r jsonb; s jsonb; admitted integer:=0; other_vid uuid; own_id uuid;
begin
 for n in 1..50 loop
  vid:=gen_random_uuid();
  insert into public.video_requests(id,user_id,topic,style,duration_seconds,status)
  values(vid,'d2064950-7a95-4208-8dfb-d93b470d141d','ROLLBACK supply fixture','Educativo',30,'script_ready');
  r:=public.pi_reserve_job_supply(vid,1,'[{"provider":"supply-job-fixture","unit":"usd","units":20,"usd":20}]');
  if (r->>'reserved')::boolean then admitted:=admitted+1; own_id:=vid; else other_vid:=vid; end if;
 end loop;
 assert admitted=25,'whole jobs oversubscribed beyond the critical buffer';
 assert (select sum(reserved_units) from public.pi_supply_job_reservations where provider='supply-job-fixture')=500;
 r:=public.pi_reserve_job_supply(own_id,1,'[{"provider":"supply-job-fixture","unit":"usd","units":20,"usd":20}]');
 assert (r->>'reserved')::boolean,'existing funded envelope cannot resume';
 assert (select sum(reserved_units) from public.pi_supply_job_reservations where provider='supply-job-fixture')=500,'same attempt reserved twice';
 insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status)
 values('supply-job-fixture-call',own_id::text,'voice','supply-job-fixture','fixture','simulation','initial',10,'RESERVED');
 r:=public.pi_submit_with_supply('supply-job-fixture-call',10);
 assert (r->>'submitted')::boolean,'a funded job was blocked by new-work critical buffer';
 s:=public.pi_supply_state('supply-job-fixture');
 assert (s->>'free')::numeric=500,'remaining envelope and paid submission counted twice';
 update public.pi_paid_operations set status='COMMITTED',committed_usd=10 where idempotency_key='supply-job-fixture-call';
 perform public.pi_release_job_supply(own_id,1);
 s:=public.pi_supply_state('supply-job-fixture');
 assert (s->>'free')::numeric=510,'unused release refunded consumed supplier units';
 r:=public.pi_submit_with_supply('supply-job-fixture-call',10);
 assert r->>'reason'='already_claimed','settled operation replayed';
 -- A lower fresh balance cannot be hidden by clamping unreserved funds to zero.
 select project_id::uuid into own_id from public.pi_supply_job_reservations where provider='supply-job-fixture' and status='OPEN' limit 1;
 insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at)
 values('supply-job-fixture','usd',5,'OK','provider_api','RED',clock_timestamp());
 insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status)
 values('supply-job-fixture-depleted',own_id::text,'image','supply-job-fixture','fixture','simulation','initial',10,'RESERVED');
 r:=public.pi_submit_with_supply('supply-job-fixture-depleted',10);
 assert not (r->>'submitted')::boolean,'job envelope ignored fresh depletion';
 assert (select status from public.pi_paid_operations where idempotency_key='supply-job-fixture-depleted')='RESERVED';
 -- All-or-nothing multi-provider reservation: an unavailable second supplier reserves neither.
 insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at)
 values('supply-job-fixture','usd',1000,'OK','provider_api','GREEN',clock_timestamp());
 r:=public.pi_reserve_job_supply(other_vid,1,'[{"provider":"supply-job-fixture","unit":"usd","units":1,"usd":1},{"provider":"openai","unit":"usd","units":1,"usd":1}]');
 assert not (r->>'reserved')::boolean;
 assert not exists(select 1 from public.pi_supply_job_reservations where project_id=other_vid::text),'partial job reservation leaked';
 -- Exact bank limit, including already accepted unfinished work.
 update public.pi_supply_policies set daily_cap_usd=public.pi_supply_spend(null,date_trunc('day',clock_timestamp())) where provider='__global__';
 r:=public.pi_reserve_job_supply(other_vid,1,'[{"provider":"supply-job-fixture","unit":"usd","units":1,"usd":1}]');
 assert r->>'reason'='global funded spend ceiling','accepted jobs were absent from bank accounting';
 assert not has_function_privilege('authenticated','public.pi_reserve_job_supply(uuid,integer,jsonb)','EXECUTE');
 assert not has_table_privilege('authenticated','public.pi_supply_job_reservations','SELECT');
end $$;
select 'PASS: 50 job decisions, 25 funded within critical buffer, atomic multi-provider envelope, idempotent reuse, no double debit, unused-only release, fresh depletion blocked, global cash limit, service-only access; zero provider HTTP' as result;
