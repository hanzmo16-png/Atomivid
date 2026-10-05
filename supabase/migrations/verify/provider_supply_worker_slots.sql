-- Run after migration, in BEGIN/ROLLBACK; no paid provider calls or permanent fixture.
do $$
declare active integer; max_workers integer; n integer; vid uuid; r jsonb; admitted integer:=0; queued integer:=0;
begin
 select count(*) into active from public.video_requests where status='processing' and progress_stage is not null and progress_stage<>'queued';
 max_workers:=active+3;
 update public.pi_supply_policies set enabled=true,max_concurrent=max_workers where provider='__global__';
 for n in 1..50 loop
  vid:=gen_random_uuid();
  insert into public.video_requests(id,user_id,topic,style,duration_seconds,status,progress_stage,render_attempts)
  values(vid,'d2064950-7a95-4208-8dfb-d93b470d141d','ROLLBACK worker fixture','Educativo',30,'processing','queued',1);
  r:=public.pi_claim_render_supply(vid,'d2064950-7a95-4208-8dfb-d93b470d141d',1);
  if (r->>'claimed')::boolean then
   admitted:=admitted+1;
   assert not (public.pi_claim_render_supply(vid,'d2064950-7a95-4208-8dfb-d93b470d141d',1)->>'claimed')::boolean,'worker claimed twice';
  else
   queued:=queued+1;
   assert (select status='processing' and progress_stage='queued' and supply_wait_started_at is not null and render_attempts=1 from public.video_requests where id=vid),'queue lost state or spent another attempt';
  end if;
 end loop;
 assert admitted=3 and queued=47,'worker fleet exceeded its configured cap';
 assert not has_function_privilege('authenticated','public.pi_claim_render_supply(uuid,uuid,integer)','EXECUTE');
 begin
  update public.pi_supply_policies set daily_cap_usd='NaN'::numeric where provider='__global__';
  raise exception 'nonfinite funded cash accepted';
 exception when check_violation then null; end;
 begin
  insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status)
  values('elevenlabs','character','Infinity'::numeric,'OK','provider_api','GREEN');
  raise exception 'infinite credit balance accepted';
 exception when check_violation then null; end;
end $$;
select 'PASS: 50 worker claims, 3 admitted, 47 durably queued, no duplicate worker or extra attempt; nonfinite money and balances refused; zero provider HTTP' as result;
