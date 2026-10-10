-- Never count a reconciled cancellation that was never sent as an API request.
-- Provider rejections/refunds continue to count, even if financially reconciled.
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
