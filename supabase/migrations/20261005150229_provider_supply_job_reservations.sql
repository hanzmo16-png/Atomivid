-- Registry entries identify secret NAMES only; no account balance or active plan is invented.
insert into public.pi_provider_accounts(provider,production_account_label,plan,secret_reference_name,status,balance_source)
select provider,'ATOMIVID production API key (account verification pending)','unverified',
 case provider when 'elevenlabs' then 'ELEVENLABS_API_KEY' when 'openai' then 'OPENAI_API_KEY'
 when 'runway' then 'RUNWAY_API_KEY' when 'heygen' then 'HEYGEN_API_KEY' when 'anthropic' then 'ANTHROPIC_API_KEY'
 when 'luma' then 'LUMA_API_KEY' when 'veo' then 'GOOGLE_API_KEY' when 'bfl' then 'BFL_API_KEY'
 when 'ltx' then 'LTX_API_KEY' when 'beatoven' then 'BEATOVEN_API_KEY' end,'unknown','none'
from public.pi_supply_policies where provider<>'__global__' on conflict(provider) do nothing;

-- Whole-job envelopes reserve supplier units and funded cash before the first media call.
-- Consumption moves from an envelope to the paid-operation ledger in the same transaction.
create table public.pi_supply_job_reservations (
 id text primary key, project_id text not null, render_attempt integer not null check(render_attempt>0),
 provider text not null references public.pi_supply_policies(provider),
 reserved_units numeric not null check(reserved_units>0), reserved_usd numeric not null check(reserved_usd>0),
 consumed_units numeric not null default 0 check(consumed_units>=0 and consumed_units<=reserved_units),
 consumed_usd numeric not null default 0 check(consumed_usd>=0 and consumed_usd<=reserved_usd),
 status text not null default 'OPEN' check(status in ('OPEN','RELEASED')),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 unique(project_id,render_attempt,provider)
);
alter table public.pi_supply_job_reservations enable row level security;
revoke all on public.pi_supply_job_reservations from anon,authenticated;
grant all on public.pi_supply_job_reservations to service_role;
create index pi_supply_jobs_open_idx on public.pi_supply_job_reservations(provider) where status='OPEN';
alter table public.pi_paid_operations add column supply_job_key text references public.pi_supply_job_reservations(id);

alter function public.pi_supply_state(text) rename to pi_supply_state_without_jobs;
create function public.pi_supply_state(p_provider text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare state jsonb; p public.pi_supply_policies%rowtype; remaining numeric; cash numeric; free_units numeric; daily numeric; coverage numeric; ratio numeric; level text;
begin
 state:=public.pi_supply_state_without_jobs(p_provider);
 if state->>'level'='UNKNOWN' then return state; end if;
 select * into p from public.pi_supply_policies where provider=p_provider;
 select coalesce(sum(reserved_units-consumed_units),0),coalesce(sum(reserved_usd-consumed_usd),0) into remaining,cash
 from public.pi_supply_job_reservations where provider=p_provider and status='OPEN';
 -- Legacy holds remain protected until explicitly reconciled or reflected in a newer balance.
 select remaining+coalesce(sum(substring(result_ref from 7)::numeric),0) into remaining
 from public.pi_paid_operations where provider=p_provider and method='capacity_hold' and result_ref ~ '^units:[0-9]+(\.[0-9]+)?$'
 and (status='RESERVED' or (status='COMMITTED' and updated_at >= (state->>'checkedAt')::timestamptz));
 free_units:=greatest(0,(state->>'free')::numeric-remaining);
 ratio:=free_units/p.baseline;
 daily:=case when (state->>'coverageHours')::numeric>0 then (state->>'free')::numeric/(state->>'coverageHours')::numeric*24 else p.daily_forecast end;
 daily:=greatest(daily,p.daily_forecast,remaining);
 coverage:=case when daily>0 then free_units/daily*24 else null end;
 level:=case when state->>'level'='RED' or free_units<=0 or ratio<=.15 or coverage<=24 then 'RED'
 when state->>'level'='YELLOW' or ratio<=.3 or coverage<=72 then 'YELLOW' else 'GREEN' end;
 return state||jsonb_build_object('level',level,'reason',level,'free',free_units,'unreserved',(state->>'free')::numeric-remaining,'held',(state->>'held')::numeric+remaining,
 'remainingRatio',ratio,'coverageHours',coverage,'dailySpend',(state->>'dailySpend')::numeric+cash,'monthlySpend',(state->>'monthlySpend')::numeric+cash);
end $$;

create function public.pi_supply_spend(p_provider text,p_start timestamptz) returns numeric
language sql security invoker set search_path='' as $$
 select coalesce((select sum(greatest(reserved_usd,coalesce(committed_usd,0))) from public.pi_paid_operations
 where (p_provider is null or provider=p_provider) and method<>'capacity_hold'
 and (status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
 or (created_at>=p_start and (status='COMMITTED' or (status='REFUNDED' and not supply_reconciled))))),0)
 +coalesce((select sum(reserved_usd-consumed_usd) from public.pi_supply_job_reservations
 where (p_provider is null or provider=p_provider) and status='OPEN'),0);
$$;

create function public.pi_reserve_job_supply(p_request_id uuid,p_attempt integer,p_demands jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare g public.pi_supply_policies%rowtype; p public.pi_supply_policies%rowtype; r public.pi_supply_job_reservations%rowtype;
 v public.video_requests%rowtype; d jsonb; state jsonb; units numeric; usd numeric; total_usd numeric:=0;
 day_start timestamptz; month_start timestamptz; result jsonb:='[]'::jsonb; rid text;
begin
 select * into g from public.pi_supply_policies where provider='__global__' for update;
 if not found or not g.enabled or g.daily_cap_usd<=0 or g.monthly_cap_usd<=0 or length(trim(g.evidence))=0 then
 return jsonb_build_object('reserved',false,'reason','funded global budget unconfigured'); end if;
 if jsonb_typeof(p_demands)<>'array' or jsonb_array_length(p_demands)>12 then raise exception 'invalid demand list'; end if;
 select * into v from public.video_requests where id=p_request_id for update;
 if not found or p_attempt<1 or not ((v.status='processing' and v.render_attempts=p_attempt)
 or (v.status in ('script_ready','failed') and v.render_attempts+1=p_attempt)) then
 return jsonb_build_object('reserved',false,'reason','request state changed'); end if;
 if (select count(*)<>count(distinct value->>'provider') from jsonb_array_elements(p_demands)) then raise exception 'duplicate demand'; end if;
 -- Validate ALL suppliers and cash before inserting ANY reservation.
 for d in select value from jsonb_array_elements(p_demands) order by value->>'provider' loop
  select * into p from public.pi_supply_policies where provider=d->>'provider' for update;
  if not found then return jsonb_build_object('reserved',false,'reason','supplier unconfigured','provider',d->>'provider'); end if;
  usd:=(d->>'usd')::numeric;
  units:=case when d->>'unit'='character' and p.unit='character' then (d->>'units')::numeric
   when d->>'unit'='usd' and p.unit='usd' then usd
   when d->>'unit'='usd' and p.unit='credit' and p.unit_cost_usd>0 then usd/p.unit_cost_usd else null end;
  if usd is null or usd<=0 or usd='NaN'::numeric or units is null or units<=0 or units='NaN'::numeric then raise exception 'invalid demand'; end if;
  select * into r from public.pi_supply_job_reservations where project_id=p_request_id::text and render_attempt=p_attempt and provider=p.provider;
  if found then
   if r.status<>'OPEN' or r.reserved_units<units or r.reserved_usd<usd then
    return jsonb_build_object('reserved',false,'reason','job envelope changed','provider',p.provider); end if;
   continue;
  end if;
  state:=public.pi_supply_state(p.provider);
  if state->>'level' in ('RED','UNKNOWN') or units>(state->>'free')::numeric then
   return jsonb_build_object('reserved',false,'reason','supplier balance unavailable','provider',p.provider); end if;
  day_start:=date_trunc('day',clock_timestamp() at time zone p.timezone) at time zone p.timezone;
  month_start:=date_trunc('month',clock_timestamp() at time zone p.timezone) at time zone p.timezone;
  if public.pi_supply_spend(p.provider,day_start)+usd>p.daily_cap_usd or public.pi_supply_spend(p.provider,month_start)+usd>p.monthly_cap_usd then
   return jsonb_build_object('reserved',false,'reason','provider funded spend ceiling','provider',p.provider); end if;
  total_usd:=total_usd+usd;
 end loop;
 day_start:=date_trunc('day',clock_timestamp() at time zone g.timezone) at time zone g.timezone;
 month_start:=date_trunc('month',clock_timestamp() at time zone g.timezone) at time zone g.timezone;
 if public.pi_supply_spend(null,day_start)+total_usd>g.daily_cap_usd or public.pi_supply_spend(null,month_start)+total_usd>g.monthly_cap_usd then
 return jsonb_build_object('reserved',false,'reason','global funded spend ceiling'); end if;
 for d in select value from jsonb_array_elements(p_demands) order by value->>'provider' loop
  select * into p from public.pi_supply_policies where provider=d->>'provider';
  usd:=(d->>'usd')::numeric; units:=case when p.unit='character' then (d->>'units')::numeric when p.unit='usd' then usd else usd/p.unit_cost_usd end;
  rid:='job:'||p_request_id::text||':'||p_attempt||':'||p.provider;
  insert into public.pi_supply_job_reservations(id,project_id,render_attempt,provider,reserved_units,reserved_usd)
  values(rid,p_request_id::text,p_attempt,p.provider,units,usd) on conflict(project_id,render_attempt,provider) do nothing;
  result:=result||jsonb_build_array(jsonb_build_object('key',rid,'provider',p.provider,'units',units));
 end loop;
 return jsonb_build_object('reserved',true,'holds',result);
end $$;

create or replace function public.pi_submit_with_supply(p_key text,p_units numeric default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare o public.pi_paid_operations%rowtype; p public.pi_supply_policies%rowtype; g public.pi_supply_policies%rowtype;
 r public.pi_supply_job_reservations%rowtype; state jsonb; units numeric; own_units numeric:=0; own_usd numeric:=0; rid text;
 day_start timestamptz; month_start timestamptz; free_spend numeric;
begin
 select * into g from public.pi_supply_policies where provider='__global__' for update;
 if not found or not g.enabled or g.daily_cap_usd<=0 or g.monthly_cap_usd<=0 or length(trim(g.evidence))=0 then
 return jsonb_build_object('submitted',false,'reason','funded global budget unconfigured'); end if;
 select * into o from public.pi_paid_operations where idempotency_key=p_key;
 if not found or o.status<>'RESERVED' then return jsonb_build_object('submitted',false,'reason','already_claimed'); end if;
 if exists(select 1 from public.pi_paid_operations where project_id=o.project_id and provider=o.provider
 and idempotency_key<>p_key and (status='RECONCILIATION_REQUIRED' or (o.provider='anthropic' and status='SUBMITTED'))) then
 return jsonb_build_object('submitted',false,'reason','previous consumption requires reconciliation'); end if;
 select * into p from public.pi_supply_policies where provider=o.provider for update;
 state:=public.pi_supply_state(o.provider);
 if state->>'level'='UNKNOWN' then return jsonb_build_object('submitted',false,'reason',state->>'reason'); end if;
 select * into r from public.pi_supply_job_reservations where project_id=o.project_id and provider=o.provider and status='OPEN' order by render_attempt desc limit 1 for update;
 if found then rid:=r.id; own_units:=r.reserved_units-r.consumed_units; own_usd:=r.reserved_usd-r.consumed_usd; end if;
 if state->>'level'='RED' and rid is null then return jsonb_build_object('submitted',false,'reason','new work paused'); end if;
 if (select health from public.pi_capacity_snapshots where provider=o.provider and unit=p.unit order by checked_at desc limit 1)='DOWN' then
 return jsonb_build_object('submitted',false,'reason','supplier unavailable'); end if;
 units:=coalesce(p_units,o.capacity_units,o.reserved_usd/p.unit_cost_usd);
 if units is null or units<0 or units='NaN'::numeric or (o.reserved_usd>0 and units<=0)
 or units>coalesce((state->>'unreserved')::numeric,(state->>'free')::numeric)+own_units then return jsonb_build_object('submitted',false,'reason','insufficient unreserved balance'); end if;
 if rid is not null and (units>own_units or o.reserved_usd>own_usd) then return jsonb_build_object('submitted',false,'reason','job envelope exhausted'); end if;
 if (state->>'activeCalls')::integer>=p.max_concurrent then return jsonb_build_object('submitted',false,'reason','concurrency'); end if;
 if (state->>'todayCalls')::integer>=p.max_daily_calls then return jsonb_build_object('submitted',false,'reason','daily request quota'); end if;
 day_start:=date_trunc('day',clock_timestamp() at time zone p.timezone) at time zone p.timezone;
 month_start:=date_trunc('month',clock_timestamp() at time zone p.timezone) at time zone p.timezone;
 if public.pi_supply_spend(p.provider,day_start)+(case when rid is null then o.reserved_usd else 0 end)>p.daily_cap_usd
 or public.pi_supply_spend(p.provider,month_start)+(case when rid is null then o.reserved_usd else 0 end)>p.monthly_cap_usd then
 return jsonb_build_object('submitted',false,'reason','provider funded spend ceiling'); end if;
 day_start:=date_trunc('day',clock_timestamp() at time zone g.timezone) at time zone g.timezone;
 month_start:=date_trunc('month',clock_timestamp() at time zone g.timezone) at time zone g.timezone;
 if public.pi_supply_spend(null,day_start)+(case when rid is null then o.reserved_usd else 0 end)>g.daily_cap_usd
 or public.pi_supply_spend(null,month_start)+(case when rid is null then o.reserved_usd else 0 end)>g.monthly_cap_usd then
 return jsonb_build_object('submitted',false,'reason','global funded spend ceiling'); end if;
 select coalesce(sum(greatest(reserved_usd,coalesce(committed_usd,0))),0) into free_spend from public.pi_paid_operations
 where supply_pool='free' and method<>'capacity_hold' and created_at>=day_start and status<>'RESERVED';
 if o.supply_pool='free' and (g.free_daily_cap_usd<=0 or free_spend+o.reserved_usd>g.free_daily_cap_usd or state->>'level'<>'GREEN') then
 return jsonb_build_object('submitted',false,'reason','free pool closed'); end if;
 update public.pi_paid_operations set status='SUBMITTED',capacity_units=units,supply_job_key=rid,updated_at=clock_timestamp()
 where idempotency_key=p_key and status='RESERVED';
 if not found then return jsonb_build_object('submitted',false,'reason','already_claimed'); end if;
 if rid is not null then update public.pi_supply_job_reservations set consumed_units=consumed_units+units,
 consumed_usd=consumed_usd+o.reserved_usd,updated_at=clock_timestamp() where id=rid; end if;
 return jsonb_build_object('submitted',true,'reason','admitted');
end $$;

-- Releases ONLY unused capacity. Submitted/uncertain consumption remains in the paid ledger.
create function public.pi_release_job_supply(p_request_id uuid,p_attempt integer) returns void
language sql security invoker set search_path='' as $$
 update public.pi_supply_job_reservations set status='RELEASED',updated_at=clock_timestamp()
 where project_id=p_request_id::text and render_attempt=p_attempt and status='OPEN';
$$;
revoke all on function public.pi_supply_state(text),public.pi_supply_spend(text,timestamptz),public.pi_reserve_job_supply(uuid,integer,jsonb),public.pi_release_job_supply(uuid,integer) from public,anon,authenticated;
grant execute on function public.pi_supply_state(text),public.pi_supply_spend(text,timestamptz),public.pi_reserve_job_supply(uuid,integer,jsonb),public.pi_release_job_supply(uuid,integer) to service_role;
