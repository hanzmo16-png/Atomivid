-- Operational regression probe. Requires a stale failed Anthropic script and a
-- pending RESERVED script in this environment. All fixtures and admissions roll back.
-- No provider call is made. Financial holds, duplicate guards and caps are asserted.
begin;
CREATE OR REPLACE FUNCTION public.pi_supply_state_without_jobs(p_provider text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
 p public.pi_supply_policies%rowtype;
 s public.pi_capacity_snapshots%rowtype;
 held numeric := 0; free_units numeric; ratio numeric; daily_units numeric; coverage numeric;
 level text; daily_spend numeric; monthly_spend numeric; active_calls integer; today_calls integer;
 day_start timestamptz; month_start timestamptz;
begin
 select * into p from public.pi_supply_policies where provider=p_provider;
 if not found or not p.enabled or p.baseline <= 0 or p.unit_cost_usd <= 0
   or p.max_concurrent <= 0 or p.max_daily_calls <= 0 or p.daily_cap_usd <= 0 or p.monthly_cap_usd <= 0
   or length(trim(p.evidence))=0 then
   return jsonb_build_object('provider',p_provider,'level','UNKNOWN','reason','policy unconfigured');
 end if;
 select * into s from public.pi_capacity_snapshots where provider=p_provider and unit=p.unit order by checked_at desc limit 1;
 if not found or s.available is null or s.available < 0 or s.reliability not in ('provider_api','manual_entry')
   or not public.pi_supply_balance_is_fresh(s.reliability, s.checked_at, clock_timestamp()) then
   return jsonb_build_object('provider',p_provider,'level','UNKNOWN','reason','balance unverified or stale');
 end if;
 day_start := date_trunc('day',clock_timestamp() at time zone p.timezone) at time zone p.timezone;
 month_start := date_trunc('month',clock_timestamp() at time zone p.timezone) at time zone p.timezone;
 select coalesce(sum(case when status='COMMITTED' and p.unit='usd' then coalesce(committed_usd,reserved_usd)
   else coalesce(capacity_units,reserved_usd/p.unit_cost_usd) end),0) into held
 from public.pi_paid_operations where provider=p_provider and method <> 'capacity_hold' and
 (status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
  or (status='COMMITTED' and updated_at >= s.checked_at)
  or (status='REFUNDED' and not supply_reconciled));
 select coalesce(sum(greatest(reserved_usd,coalesce(committed_usd,0))),0) into daily_spend
 from public.pi_paid_operations where provider=p_provider and method <> 'capacity_hold' and created_at >= day_start
 and (status not in ('RESERVED','REFUNDED') or (status='REFUNDED' and not supply_reconciled));
 select coalesce(sum(greatest(reserved_usd,coalesce(committed_usd,0))),0) into monthly_spend
 from public.pi_paid_operations where provider=p_provider and method <> 'capacity_hold' and created_at >= month_start
 and (status not in ('RESERVED','REFUNDED') or (status='REFUNDED' and not supply_reconciled));
 select count(*) into active_calls from public.pi_paid_operations o where provider=p_provider
 and method <> 'capacity_hold' and status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
 and not (o.status='RECONCILIATION_REQUIRED' and o.provider='openai'
   and o.method='visual_relevance_review' and o.provider_job_id is null
   and exists(select 1 from public.video_requests v where v.id::text=o.project_id and v.status='completed'));
 select count(*) into today_calls from public.pi_paid_operations where provider=p_provider
 and method <> 'capacity_hold' and created_at >= day_start and status <> 'RESERVED'
 and not (status='REFUNDED' and supply_reconciled and committed_usd=0 and provider_job_id is null
          and result_ref like 'cancelled-before-submission:%');
 select greatest(p.daily_forecast,coalesce(max(day_units),0)) into daily_units from (
  select sum(coalesce(capacity_units,reserved_usd/p.unit_cost_usd)) day_units
  from public.pi_paid_operations where provider=p_provider and method <> 'capacity_hold'
  and status not in ('RESERVED','REFUNDED') and created_at >= clock_timestamp()-interval '7 days'
  group by (created_at at time zone p.timezone)::date
 ) usage;
 free_units:=greatest(0,s.available-held); ratio:=free_units/p.baseline;
 coverage:=case when daily_units>0 then free_units/daily_units*24 else null end;
 level:=case when s.health='DOWN' or free_units<=0 or ratio<=.15 or coverage<=24 then 'RED'
  when s.health <> 'OK' or ratio<=.3 or coverage<=72 then 'YELLOW' else 'GREEN' end;
 return jsonb_build_object('provider',p_provider,'level',level,'free',free_units,'held',held,'baseline',p.baseline,
  'remainingRatio',ratio,'coverageHours',coverage,'dailySpend',daily_spend,'monthlySpend',monthly_spend,
  'activeCalls',active_calls,'todayCalls',today_calls,'unit',p.unit,'checkedAt',s.checked_at,'reason',level);
end $function$
;
select set_config('codex.supply_before',public.pi_supply_state('anthropic')::text,true);
CREATE OR REPLACE FUNCTION public.pi_supply_state_without_jobs(p_provider text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
 p public.pi_supply_policies%rowtype;
 s public.pi_capacity_snapshots%rowtype;
 held numeric := 0; free_units numeric; ratio numeric; daily_units numeric; coverage numeric;
 level text; daily_spend numeric; monthly_spend numeric; active_calls integer; today_calls integer;
 day_start timestamptz; month_start timestamptz;
begin
 select * into p from public.pi_supply_policies where provider=p_provider;
 if not found or not p.enabled or p.baseline <= 0 or p.unit_cost_usd <= 0
   or p.max_concurrent <= 0 or p.max_daily_calls <= 0 or p.daily_cap_usd <= 0 or p.monthly_cap_usd <= 0
   or length(trim(p.evidence))=0 then
   return jsonb_build_object('provider',p_provider,'level','UNKNOWN','reason','policy unconfigured');
 end if;
 select * into s from public.pi_capacity_snapshots where provider=p_provider and unit=p.unit order by checked_at desc limit 1;
 if not found or s.available is null or s.available < 0 or s.reliability not in ('provider_api','manual_entry')
   or not public.pi_supply_balance_is_fresh(s.reliability, s.checked_at, clock_timestamp()) then
   return jsonb_build_object('provider',p_provider,'level','UNKNOWN','reason','balance unverified or stale');
 end if;
 day_start := date_trunc('day',clock_timestamp() at time zone p.timezone) at time zone p.timezone;
 month_start := date_trunc('month',clock_timestamp() at time zone p.timezone) at time zone p.timezone;
 select coalesce(sum(case when status='COMMITTED' and p.unit='usd' then coalesce(committed_usd,reserved_usd)
   else coalesce(capacity_units,reserved_usd/p.unit_cost_usd) end),0) into held
 from public.pi_paid_operations where provider=p_provider and method <> 'capacity_hold' and
 (status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
  or (status='COMMITTED' and updated_at >= s.checked_at)
  or (status='REFUNDED' and not supply_reconciled));
 select coalesce(sum(greatest(reserved_usd,coalesce(committed_usd,0))),0) into daily_spend
 from public.pi_paid_operations where provider=p_provider and method <> 'capacity_hold' and created_at >= day_start
 and (status not in ('RESERVED','REFUNDED') or (status='REFUNDED' and not supply_reconciled));
 select coalesce(sum(greatest(reserved_usd,coalesce(committed_usd,0))),0) into monthly_spend
 from public.pi_paid_operations where provider=p_provider and method <> 'capacity_hold' and created_at >= month_start
 and (status not in ('RESERVED','REFUNDED') or (status='REFUNDED' and not supply_reconciled));
 select count(*) into active_calls from public.pi_paid_operations o where provider=p_provider
 and method <> 'capacity_hold' and status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
 -- Synchronous script execution has ended when its owning request failed.
 -- Billing remains uncertain: keep the ledger row, held amount and same-project
 -- reconciliation gate. Only release its concurrency slot after a one-hour grace.
 and not (o.status='RECONCILIATION_REQUIRED' and o.provider='anthropic'
   and o.method='generate_script' and o.provider_job_id is null
   and o.updated_at < clock_timestamp()-interval '1 hour'
   and exists(select 1 from public.video_requests v where v.id::text=o.project_id and v.status='failed'))
 and not (o.status='RECONCILIATION_REQUIRED' and o.provider='openai'
   and o.method='visual_relevance_review' and o.provider_job_id is null
   and exists(select 1 from public.video_requests v where v.id::text=o.project_id and v.status='completed'));
 select count(*) into today_calls from public.pi_paid_operations where provider=p_provider
 and method <> 'capacity_hold' and created_at >= day_start and status <> 'RESERVED'
 and not (status='REFUNDED' and supply_reconciled and committed_usd=0 and provider_job_id is null
          and result_ref like 'cancelled-before-submission:%');
 select greatest(p.daily_forecast,coalesce(max(day_units),0)) into daily_units from (
  select sum(coalesce(capacity_units,reserved_usd/p.unit_cost_usd)) day_units
  from public.pi_paid_operations where provider=p_provider and method <> 'capacity_hold'
  and status not in ('RESERVED','REFUNDED') and created_at >= clock_timestamp()-interval '7 days'
  group by (created_at at time zone p.timezone)::date
 ) usage;
 free_units:=greatest(0,s.available-held); ratio:=free_units/p.baseline;
 coverage:=case when daily_units>0 then free_units/daily_units*24 else null end;
 level:=case when s.health='DOWN' or free_units<=0 or ratio<=.15 or coverage<=24 then 'RED'
  when s.health <> 'OK' or ratio<=.3 or coverage<=72 then 'YELLOW' else 'GREEN' end;
 return jsonb_build_object('provider',p_provider,'level',level,'free',free_units,'held',held,'baseline',p.baseline,
  'remainingRatio',ratio,'coverageHours',coverage,'dailySpend',daily_spend,'monthlySpend',monthly_spend,
  'activeCalls',active_calls,'todayCalls',today_calls,'unit',p.unit,'checkedAt',s.checked_at,'reason',level);
end $function$
;
do $verify$
declare oldop public.pi_paid_operations%rowtype; newop public.pi_paid_operations%rowtype;
 before_state jsonb; after_state jsonb; r jsonb; probe_key text; case_row record;
 failed_fixture uuid:=gen_random_uuid(); pending_fixture uuid:=gen_random_uuid(); fixture_owner uuid; provider_day numeric; global_day numeric;
begin
 select o.* into strict oldop from public.pi_paid_operations o
 where o.provider='anthropic' and o.method='generate_script' and o.status='RECONCILIATION_REQUIRED'
 and o.provider_job_id is null and o.updated_at<clock_timestamp()-interval '1 hour'
 and exists(select 1 from public.video_requests v where v.id::text=o.project_id and v.status='failed')
 order by o.updated_at limit 1;
 select o.* into strict newop from public.pi_paid_operations o where o.provider='anthropic'
 and o.method='generate_script' and o.status='RESERVED'
 and exists(select 1 from public.video_requests v where v.id::text=o.project_id and v.status='pending')
 order by o.created_at desc limit 1;
 select daily_cap_usd into provider_day from public.pi_supply_policies where provider='anthropic';
 select daily_cap_usd into global_day from public.pi_supply_policies where provider='__global__';
 before_state:=current_setting('codex.supply_before')::jsonb;
 after_state:=public.pi_supply_state('anthropic');
 assert (after_state->>'activeCalls')::int=(before_state->>'activeCalls')::int-1, 'stale failed script slot not released';
 assert after_state-'activeCalls'-'coverageHours'=before_state-'activeCalls'-'coverageHours','financial state changed';
 select user_id into fixture_owner from public.video_requests where id::text=oldop.project_id;
 insert into public.video_requests(id,user_id,topic,style,duration_seconds,status,language,mode)
 values(failed_fixture,fixture_owner,'Rollback-only failed fixture','Educativo',30,'failed','es','visual'),
 (pending_fixture,fixture_owner,'Rollback-only pending fixture','Educativo',30,'pending','es','visual');

 for case_row in select * from (values
 ('old failed uncertain','RECONCILIATION_REQUIRED','generate_script',null::text,interval '2 hours',failed_fixture,0),
 ('recent failed uncertain','RECONCILIATION_REQUIRED','generate_script',null::text,interval '0 seconds',failed_fixture,1),
 ('submitted','SUBMITTED','generate_script',null::text,interval '2 hours',failed_fixture,1),
 ('recorded job','RECONCILIATION_REQUIRED','generate_script','rollback-only-job',interval '2 hours',failed_fixture,1),
 ('other method','RECONCILIATION_REQUIRED','rollback-only-other-method',null::text,interval '2 hours',failed_fixture,1),
 ('nonterminal request','RECONCILIATION_REQUIRED','generate_script',null::text,interval '2 hours',pending_fixture,1))
 as cases(name,status,method,job,age,project,expected_extra)
 loop
  probe_key:='rollback-only-'||gen_random_uuid()::text;
  insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,capacity_units,supply_pool,provider_job_id,updated_at)
  values(probe_key,case_row.project::text,'probe','anthropic',newop.model,case_row.method,'initial',0.0001,case_row.status,0.0001,'paid',case_row.job,clock_timestamp()-case_row.age);
  assert (public.pi_supply_state('anthropic')->>'activeCalls')::int=(after_state->>'activeCalls')::int+case_row.expected_extra,
   'active call count incorrect for fixture';
  -- End each synthetic fixture through a permitted forward transition.
  update public.pi_paid_operations set status='COMMITTED',committed_usd=0,result_ref='rollback-only:test-fixture'
   where idempotency_key=probe_key;
 end loop;

 r:=public.pi_submit_with_supply(oldop.idempotency_key);
 assert r->>'submitted'='false' and r->>'reason'='already_claimed','old uncertain operation resubmitted';
 probe_key:='rollback-only-duplicate-'||gen_random_uuid()::text;
 insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,capacity_units,supply_pool)
 values(probe_key,oldop.project_id,'probe','anthropic',newop.model,'generate_script','initial',0.0001,'RESERVED',0.0001,'paid');
 r:=public.pi_submit_with_supply(probe_key);
 assert r->>'submitted'='false' and r->>'reason'='previous consumption requires reconciliation','same project duplicate not blocked';

 probe_key:='rollback-only-free-'||gen_random_uuid()::text;
 insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,capacity_units,supply_pool)
 values(probe_key,pending_fixture::text,'probe','anthropic',newop.model,'generate_script','initial',0.0001,'RESERVED',0.0001,'free');
 r:=public.pi_submit_with_supply(probe_key);
 assert r->>'submitted'='false' and r->>'reason'='free pool closed','unfunded free pool opened';

 update public.pi_supply_policies set daily_cap_usd=0.001 where provider='anthropic';
 r:=public.pi_submit_with_supply(newop.idempotency_key);
 assert r->>'submitted'='false' and r->>'reason'='provider funded spend ceiling','provider cap bypassed';
 update public.pi_supply_policies set daily_cap_usd=provider_day where provider='anthropic';
 update public.pi_supply_policies set daily_cap_usd=0.001 where provider='__global__';
 r:=public.pi_submit_with_supply(newop.idempotency_key);
 assert r->>'submitted'='false' and r->>'reason'='global funded spend ceiling','global cap bypassed';
 update public.pi_supply_policies set daily_cap_usd=global_day where provider='__global__';

 r:=public.pi_submit_with_supply(newop.idempotency_key);
 assert r->>'submitted'='true','new independent request not admitted';
 assert (public.pi_supply_state('anthropic')->>'activeCalls')::int=1,'live new call not counted';
 probe_key:='rollback-only-concurrency-'||gen_random_uuid()::text;
 insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,capacity_units,supply_pool)
 values(probe_key,'rollback-only-independent-project','probe','anthropic',newop.model,'generate_script','initial',0.0001,'RESERVED',0.0001,'paid');
 r:=public.pi_submit_with_supply(probe_key);
 assert r->>'submitted'='false' and r->>'reason'='concurrency','one actual concurrent call limit bypassed';
 assert (select status='RECONCILIATION_REQUIRED' and committed_usd is null and not supply_reconciled from public.pi_paid_operations where idempotency_key=oldop.idempotency_key),'uncertain billing history altered';
end $verify$;
rollback;
select 'PASS: transaction rolled back; zero provider calls' as result;
