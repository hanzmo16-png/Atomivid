-- PREPARED ONLY. Requires explicit approval before any production application.
-- Keeps the existing paid ledger and job envelopes; this registry is authorization, not a second ledger.
create schema if not exists pi_internal;
revoke all on schema pi_internal from public,anon,authenticated;
grant usage on schema pi_internal to service_role;
create function pi_internal.reserve_supply_envelope(p_project_id text,p_attempt integer,p_demands jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare g public.pi_supply_policies%rowtype; p public.pi_supply_policies%rowtype; r public.pi_supply_job_reservations%rowtype;
  d jsonb; state jsonb; units numeric; usd numeric; total_usd numeric:=0;
 day_start timestamptz; month_start timestamptz; result jsonb:='[]'::jsonb; rid text;
begin
 select * into g from public.pi_supply_policies where provider='__global__' for update;
 if not found or not g.enabled or g.daily_cap_usd<=0 or g.monthly_cap_usd<=0 or length(trim(g.evidence))=0 then
 return jsonb_build_object('reserved',false,'reason','funded global budget unconfigured'); end if;
 if jsonb_typeof(p_demands)<>'array' or jsonb_array_length(p_demands)>12 then raise exception 'invalid demand list'; end if;
 if p_attempt<1 or length(p_project_id)<1 then raise exception 'invalid envelope identity'; end if;
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
  select * into r from public.pi_supply_job_reservations where project_id=p_project_id and render_attempt=p_attempt and provider=p.provider;
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
  rid:='job:'||p_project_id||':'||p_attempt||':'||p.provider;
  insert into public.pi_supply_job_reservations(id,project_id,render_attempt,provider,reserved_units,reserved_usd)
  values(rid,p_project_id,p_attempt,p.provider,units,usd) on conflict(project_id,render_attempt,provider) do nothing;
  result:=result||jsonb_build_array(jsonb_build_object('key',rid,'provider',p.provider,'units',units));
 end loop;
 return jsonb_build_object('reserved',true,'holds',result);
end $$;


revoke all on function pi_internal.reserve_supply_envelope(text,integer,jsonb) from public,anon,authenticated;
grant execute on function pi_internal.reserve_supply_envelope(text,integer,jsonb) to service_role;

-- Video and Audio use exactly the same envelope admission implementation.
create or replace function public.pi_reserve_job_supply(p_request_id uuid,p_attempt integer,p_demands jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v public.video_requests%rowtype;
begin
 perform 1 from public.pi_supply_policies where provider='__global__' for update;
 select * into v from public.video_requests where id=p_request_id for update;
 if not found or p_attempt<1 or not ((v.status='processing' and v.render_attempts=p_attempt)
  or (v.status in ('script_ready','failed') and v.render_attempts+1=p_attempt)) then
  return jsonb_build_object('reserved',false,'reason','request state changed'); end if;
 return pi_internal.reserve_supply_envelope(p_request_id::text,p_attempt,p_demands);
end $$;
revoke all on function public.pi_reserve_job_supply(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.pi_reserve_job_supply(uuid,integer,jsonb) to service_role;

create table public.pi_audio_supply_authorizations (
 auth_ref text primary key check(auth_ref ~ '^[0-9a-f]{64}$'),
 project_key text not null,
 attempt integer not null check(attempt>0),
 facts jsonb not null,
 legacy_spent numeric not null default 0, legacy_calls integer not null default 0, legacy_chars integer not null default 0,
 manifest jsonb not null check(jsonb_typeof(manifest)='array'),
 status text not null default 'ACTIVE' check(status in ('ACTIVE','CLOSED')),
 created_at timestamptz not null default clock_timestamp(),
 unique(project_key,attempt)
);
create unique index pi_audio_one_active on public.pi_audio_supply_authorizations(project_key) where status='ACTIVE';
alter table public.pi_audio_supply_authorizations enable row level security;
revoke all on public.pi_audio_supply_authorizations from public,anon,authenticated;
revoke all on public.pi_audio_supply_authorizations from service_role;
grant select,insert,update on public.pi_audio_supply_authorizations to service_role;
create unique index pi_audio_facts_unique on public.pi_audio_supply_authorizations(project_key,facts);
create function pi_internal.audio_authorization_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'audio authorization history immutable'; end if;
 if (to_jsonb(new)-'status') is distinct from (to_jsonb(old)-'status') or old.status<>'ACTIVE' or new.status<>'CLOSED' then
  raise exception 'audio authorization immutable'; end if;
 return new;
end $$;
revoke all on function pi_internal.audio_authorization_immutable() from public,anon,authenticated,service_role;
create trigger pi_audio_immutable before update or delete on public.pi_audio_supply_authorizations for each row execute function pi_internal.audio_authorization_immutable();

create function public.pi_reserve_audio_supply(p_ref text,p_facts jsonb,p_manifest jsonb,p_legacy jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a public.pi_audio_supply_authorizations%rowtype; root text; attempt integer;
 legacy_spent numeric; legacy_calls integer; legacy_chars integer; total numeric; chars numeric; cap numeric; result jsonb; item jsonb;
begin
 perform 1 from public.pi_supply_policies where provider='__global__' for update;
 if not found then return jsonb_build_object('reserved',false,'reason','global policy absent'); end if;
 if p_ref is null or p_ref !~ '^[0-9a-f]{64}$' or p_facts is null or jsonb_typeof(p_facts)<>'object'
 or p_manifest is null or jsonb_typeof(p_manifest)<>'array' or jsonb_array_length(p_manifest)>4000 then raise exception 'invalid audio contract'; end if;
 root:='audio:'||(p_facts->>'ownerId')::uuid::text||':'||(p_facts->>'projectId')::uuid::text;
 cap:=(p_facts->>'usd')::numeric;
 if cap is null or cap<=0 or cap>20 or cap='NaN'::numeric
 or (p_facts->>'revision')::integer<1 or (p_facts->>'model') not in ('eleven_multilingual_v2','eleven_v4_turbo')
 or (p_facts->>'fingerprint') !~ '^[0-9a-f]{64}$' or (p_facts->>'at')::timestamptz>clock_timestamp()+interval '1 minute'
 or exists(select 1 from jsonb_each(p_facts) where value='null'::jsonb)
 or not (p_facts ?& array['ownerId','projectId','usd','revision','model','fingerprint','at']) then raise exception 'invalid audio authorization'; end if;
 for item in select value from jsonb_array_elements(p_manifest) loop
  if item->>'key' is null or item->>'key' !~ '^audio_[0-9a-f]{64}$'
  or item->>'segment' is null or item->>'segment' !~ '^[0-9a-f]{64}$'
  or item->>'provider' is distinct from 'elevenlabs' or item->>'model' is distinct from p_facts->>'model'
  or (item->>'usd')::numeric is null or (item->>'usd')::numeric<=0 or (item->>'usd')::numeric>cap
  or (item->>'characters')::integer is null or (item->>'characters')::integer<=0 then raise exception 'invalid audio segment'; end if;
 end loop;
 if (select count(*)<>count(distinct value->>'key') or count(*)<>count(distinct value->>'segment') from jsonb_array_elements(p_manifest)) then raise exception 'duplicate audio segment'; end if;
 select coalesce(sum((value->>'usd')::numeric),0),coalesce(sum((value->>'characters')::numeric),0) into total,chars from jsonb_array_elements(p_manifest);
 if total>cap or total='NaN'::numeric then return jsonb_build_object('reserved',false,'reason','audio authorization exceeded'); end if;
 select * into a from public.pi_audio_supply_authorizations where auth_ref=p_ref;
 if found then
  if a.status<>'ACTIVE' or a.project_key<>root or a.facts<>p_facts
   or exists(select 1 from jsonb_array_elements(p_manifest) m where not a.manifest @> jsonb_build_array(m.value)) then
   return jsonb_build_object('reserved',false,'reason','audio authorization changed'); end if;
  return jsonb_build_object('reserved',true,'attempt',a.attempt);
 end if;
 if exists(select 1 from public.pi_paid_operations where project_id=root and
  (status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED') or (status='REFUNDED' and not supply_reconciled))) then
  return jsonb_build_object('reserved',false,'reason','audio reconciliation required'); end if;
 -- A committed segment with a missing cache must be restored, never silently synthesized/charged twice.
 if exists(select 1 from public.pi_paid_operations o join jsonb_array_elements(p_manifest) m on o.shot_id=m.value->>'segment'
  where o.project_id=root and o.status='COMMITTED') then
  return jsonb_build_object('reserved',false,'reason','audio committed cache requires restoration'); end if;
 select coalesce(max(x.attempt),0)+1 into attempt from public.pi_audio_supply_authorizations x where project_key=root;
 -- All changes roll back if the admission helper refuses: old authorization/holds stay intact.
 begin
  update public.pi_supply_job_reservations set status='RELEASED',updated_at=clock_timestamp() where project_id=root and status='OPEN';
  if total>0 then
   result:=pi_internal.reserve_supply_envelope(root,attempt,jsonb_build_array(jsonb_build_object('provider','elevenlabs','unit','character','units',chars,'usd',total)));
   if result->>'reserved' is distinct from 'true' then raise exception using errcode='P0002',message='audio supply refused',detail=result::text; end if;
  end if;
  update public.pi_audio_supply_authorizations set status='CLOSED' where project_key=root and status='ACTIVE';
  select x.legacy_spent,x.legacy_calls,x.legacy_chars into legacy_spent,legacy_calls,legacy_chars from public.pi_audio_supply_authorizations x where project_key=root order by x.attempt limit 1;
  if not found then
   select greatest(0,(p_legacy->>'spentUsd')::numeric-coalesce(sum(committed_usd),0)),
    greatest(0,(p_legacy->>'calls')::integer-count(*)::integer),
    greatest(0,(p_legacy->>'characters')::integer-coalesce(sum(capacity_units),0)::integer)
   into legacy_spent,legacy_calls,legacy_chars from public.pi_paid_operations where project_id=root and status='COMMITTED';
  end if;
  if legacy_spent is null or legacy_calls is null or legacy_chars is null or legacy_spent='NaN'::numeric or legacy_spent<0 or legacy_calls<0 or legacy_chars<0 then raise exception 'invalid legacy baseline'; end if;
  insert into public.pi_audio_supply_authorizations(auth_ref,project_key,attempt,facts,manifest,legacy_spent,legacy_calls,legacy_chars)
  values(p_ref,root,attempt,p_facts,p_manifest,legacy_spent,legacy_calls,legacy_chars);
 exception when no_data_found then
  return jsonb_build_object('reserved',false,'reason','audio supply unavailable');
 end;
 return jsonb_build_object('reserved',true,'attempt',attempt);
end $$;
revoke all on function public.pi_reserve_audio_supply(text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.pi_reserve_audio_supply(text,jsonb,jsonb,jsonb) to service_role;

-- Preserve the exact installed Reel/recovery wrapper, including its privileges and accounting logic.
alter function public.pi_submit_with_supply(text,numeric) set schema pi_internal;
alter function pi_internal.pi_submit_with_supply(text,numeric) rename to submit_before_audio;
revoke all on function pi_internal.submit_before_audio(text,numeric) from public,anon,authenticated;
grant execute on function pi_internal.submit_before_audio(text,numeric) to service_role;
create function public.pi_submit_with_supply(p_key text,p_units numeric default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare o public.pi_paid_operations%rowtype; a public.pi_audio_supply_authorizations%rowtype; item jsonb;
begin
 perform 1 from public.pi_supply_policies where provider='__global__' for update;
 select * into o from public.pi_paid_operations where idempotency_key=p_key;
 if o.project_id like 'audio:%' then
  select * into a from public.pi_audio_supply_authorizations where project_key=o.project_id and status='ACTIVE';
  if not found then return jsonb_build_object('submitted',false,'reason','audio authorization absent'); end if;
  select value into item from jsonb_array_elements(a.manifest) where value->>'key'=p_key;
  if item is null or o.status<>'RESERVED' or o.shot_id is distinct from item->>'segment'
   or o.provider is distinct from item->>'provider' or o.model is distinct from item->>'model'
   or o.method is distinct from 'audio_studio_tts_tariff_estimate'
   or o.reserved_usd is distinct from (item->>'usd')::numeric or p_units is distinct from (item->>'characters')::numeric then
   return jsonb_build_object('submitted',false,'reason','audio operation outside authorization'); end if;
  if exists(select 1 from public.pi_paid_operations where project_id=o.project_id and shot_id=o.shot_id and idempotency_key<>p_key
    and (status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED','COMMITTED') or (status='REFUNDED' and not supply_reconciled))) then
   return jsonb_build_object('submitted',false,'reason','audio segment already submitted'); end if;
 end if;
 return pi_internal.submit_before_audio(p_key,p_units);
end $$;
revoke all on function public.pi_submit_with_supply(text,numeric) from public,anon,authenticated;
grant execute on function public.pi_submit_with_supply(text,numeric) to service_role;

create function public.pi_audio_supply_usage(p_root text) returns jsonb language sql security invoker set search_path='' as $$
 select jsonb_build_object('spentUsd',a.legacy_spent+coalesce(sum(o.committed_usd),0),'calls',a.legacy_calls+count(o.*),'characters',a.legacy_chars+coalesce(sum(o.capacity_units),0))
 from public.pi_audio_supply_authorizations a left join public.pi_paid_operations o on o.project_id=a.project_key and o.status='COMMITTED'
 where a.project_key=p_root and a.status='ACTIVE' group by a.auth_ref;
$$;
revoke all on function public.pi_audio_supply_usage(text) from public,anon,authenticated;
grant execute on function public.pi_audio_supply_usage(text) to service_role;
