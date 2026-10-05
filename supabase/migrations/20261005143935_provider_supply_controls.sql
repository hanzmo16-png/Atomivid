-- Preventive supply control. No credits, plans, payments or customer data are changed.
-- Policies start CLOSED until real balances, funded ceilings and account limits are verified.
create table public.pi_supply_policies (
  provider text primary key,
  enabled boolean not null default false,
  unit text not null check (unit in ('character','usd','credit')),
  baseline numeric not null default 0 check (baseline >= 0),
  unit_cost_usd numeric not null default 0 check (unit_cost_usd >= 0),
  daily_forecast numeric not null default 0 check (daily_forecast >= 0),
  daily_cap_usd numeric not null default 0 check (daily_cap_usd >= 0),
  monthly_cap_usd numeric not null default 0 check (monthly_cap_usd >= 0),
  max_concurrent integer not null default 0 check (max_concurrent >= 0),
  max_daily_calls integer not null default 0 check (max_daily_calls >= 0),
  free_daily_cap_usd numeric not null default 0 check (free_daily_cap_usd >= 0),
  timezone text not null default 'America/Cancun',
  evidence text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.pi_supply_policies enable row level security;
revoke all on public.pi_supply_policies from anon, authenticated;
grant all on public.pi_supply_policies to service_role;
insert into public.pi_supply_policies(provider,unit) values
 ('__global__','usd'),('anthropic','usd'),('elevenlabs','character'),('openai','usd'),
 ('runway','credit'),('heygen','usd'),('luma','usd'),('veo','usd'),('bfl','credit'),('ltx','usd'),('beatoven','usd');

alter table public.pi_paid_operations add column capacity_units numeric check(capacity_units is null or capacity_units >= 0);
alter table public.pi_paid_operations add column supply_pool text not null default 'paid' check(supply_pool in ('paid','free'));
alter table public.pi_paid_operations add column supply_reconciled boolean not null default false;
create index pi_supply_paid_provider_idx on public.pi_paid_operations(provider,created_at)
 where method <> 'capacity_hold';

create table public.pi_supply_alerts (
  id text primary key, provider text not null, level text not null check(level in ('YELLOW','RED','UNKNOWN')),
  payload jsonb not null, created_at timestamptz not null default now(),
  delivered_at timestamptz, delivery_error text
);
alter table public.pi_supply_alerts enable row level security;
revoke all on public.pi_supply_alerts from anon, authenticated;
grant all on public.pi_supply_alerts to service_role;
create index pi_supply_alert_pending_idx on public.pi_supply_alerts(created_at) where delivered_at is null;

create or replace function public.pi_supply_state(p_provider text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
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
   or s.checked_at > clock_timestamp() or s.checked_at < clock_timestamp()-interval '5 minutes' then
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
 select count(*) into active_calls from public.pi_paid_operations where provider=p_provider
 and method <> 'capacity_hold' and status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED');
 select count(*) into today_calls from public.pi_paid_operations where provider=p_provider
 and method <> 'capacity_hold' and created_at >= day_start and status <> 'RESERVED';
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
end $$;

-- One transaction owns the global budget lock, provider lock and operation CAS.
-- A denied operation stays RESERVED: no HTTP happened, so it can safely wait for supply.
create or replace function public.pi_submit_with_supply(p_key text, p_units numeric default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
 o public.pi_paid_operations%rowtype; p public.pi_supply_policies%rowtype; g public.pi_supply_policies%rowtype;
 state jsonb; units numeric; global_day numeric; global_month numeric; free_spend numeric;
 day_start timestamptz; month_start timestamptz;
begin
 select * into g from public.pi_supply_policies where provider='__global__' for update;
 if not found or not g.enabled or g.daily_cap_usd<=0 or g.monthly_cap_usd<=0 or length(trim(g.evidence))=0 then
  return jsonb_build_object('submitted',false,'reason','funded global budget unconfigured'); end if;
 select * into o from public.pi_paid_operations where idempotency_key=p_key;
 if not found or o.status <> 'RESERVED' then return jsonb_build_object('submitted',false,'reason','already_claimed'); end if;
 select * into p from public.pi_supply_policies where provider=o.provider for update;
 state:=public.pi_supply_state(o.provider);
 if state->>'level' in ('RED','UNKNOWN') then return jsonb_build_object('submitted',false,'reason',state->>'reason'); end if;
 units:=coalesce(p_units,o.capacity_units,o.reserved_usd/p.unit_cost_usd);
 if units is null or units<0 or (o.reserved_usd>0 and units<=0) or units>(state->>'free')::numeric then
  return jsonb_build_object('submitted',false,'reason','insufficient unreserved balance'); end if;
 if (state->>'activeCalls')::integer>=p.max_concurrent then
  return jsonb_build_object('submitted',false,'reason','concurrency'); end if;
 if (state->>'todayCalls')::integer>=p.max_daily_calls then
  return jsonb_build_object('submitted',false,'reason','daily request quota'); end if;
 if (state->>'dailySpend')::numeric+o.reserved_usd>p.daily_cap_usd
  or (state->>'monthlySpend')::numeric+o.reserved_usd>p.monthly_cap_usd then
  return jsonb_build_object('submitted',false,'reason','provider funded spend ceiling'); end if;
 day_start:=date_trunc('day',clock_timestamp() at time zone g.timezone) at time zone g.timezone;
 month_start:=date_trunc('month',clock_timestamp() at time zone g.timezone) at time zone g.timezone;
 select coalesce(sum(greatest(reserved_usd,coalesce(committed_usd,0))) filter(where created_at>=day_start),0),
  coalesce(sum(greatest(reserved_usd,coalesce(committed_usd,0))),0),
  coalesce(sum(greatest(reserved_usd,coalesce(committed_usd,0))) filter(where supply_pool='free' and created_at>=day_start),0)
 into global_day,global_month,free_spend from public.pi_paid_operations where method <> 'capacity_hold'
 and created_at>=month_start and (status not in ('RESERVED','REFUNDED') or (status='REFUNDED' and not supply_reconciled));
 if global_day+o.reserved_usd>g.daily_cap_usd or global_month+o.reserved_usd>g.monthly_cap_usd then
  return jsonb_build_object('submitted',false,'reason','global funded spend ceiling'); end if;
 if o.supply_pool='free' and (g.free_daily_cap_usd<=0 or free_spend+o.reserved_usd>g.free_daily_cap_usd
  or state->>'level'<>'GREEN') then return jsonb_build_object('submitted',false,'reason','free pool closed'); end if;
 update public.pi_paid_operations set status='SUBMITTED',capacity_units=units,updated_at=clock_timestamp()
 where idempotency_key=p_key and status='RESERVED';
 return jsonb_build_object('submitted',found,'reason',case when found then 'admitted' else 'already_claimed' end);
end $$;
revoke all on function public.pi_supply_state(text) from public, anon, authenticated;
revoke all on function public.pi_submit_with_supply(text,numeric) from public, anon, authenticated;
grant execute on function public.pi_supply_state(text), public.pi_submit_with_supply(text,numeric) to service_role;

-- Durable waiting metadata, written only by trusted workers. Does not change customer quota.
alter table public.video_requests add column supply_wait_started_at timestamptz;
alter table public.video_requests add column supply_not_before timestamptz;
