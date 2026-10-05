-- Bound active media workers separately from each supplier's concurrent HTTP calls.
-- No TTL can release a running/uncertain job; an operator reconciles an orphan.
create function public.pi_worker_supply_slots() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare g public.pi_supply_policies%rowtype; active integer;
begin
 select * into g from public.pi_supply_policies where provider='__global__';
 select count(*) into active from public.video_requests where status='processing' and progress_stage is not null and progress_stage<>'queued';
 return jsonb_build_object('configured',g.enabled and g.max_concurrent>0,'active',active,
 'free',case when g.enabled and g.max_concurrent>0 then greatest(0,g.max_concurrent-active) else 0 end);
end $$;
create function public.pi_claim_render_supply(p_request_id uuid,p_owner_id uuid,p_attempt integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare g public.pi_supply_policies%rowtype; v public.video_requests%rowtype; slots jsonb;
begin
 select * into g from public.pi_supply_policies where provider='__global__' for update;
 select * into v from public.video_requests where id=p_request_id and user_id=p_owner_id and status='processing'
 and render_attempts=p_attempt and (progress_stage is null or progress_stage='queued') for update;
 if not found then return jsonb_build_object('claimed',false,'reason','already_claimed'); end if;
 slots:=public.pi_worker_supply_slots();
 if not (slots->>'configured')::boolean or (slots->>'free')::integer<=0 then
 update public.video_requests set progress_stage='queued',supply_wait_started_at=coalesce(supply_wait_started_at,clock_timestamp()),
 supply_not_before=clock_timestamp()+interval '5 minutes',error_message='Estamos esperando disponibilidad de producción. Tu solicitud y sus avances están guardados.' where id=p_request_id;
 return jsonb_build_object('claimed',false,'reason','worker capacity'); end if;
 update public.video_requests set progress_stage='voice',supply_wait_started_at=null,supply_not_before=null where id=p_request_id;
 return jsonb_build_object('claimed',true,'reason','admitted');
end $$;
revoke all on function public.pi_worker_supply_slots(),public.pi_claim_render_supply(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.pi_worker_supply_slots(),public.pi_claim_render_supply(uuid,uuid,integer) to service_role;

-- PostgreSQL numeric also supports NaN/infinities: none is spendable supply or a budget.
alter table public.pi_supply_policies add constraint pi_supply_policy_finite check (
 baseline::text not in ('NaN','Infinity','-Infinity') and unit_cost_usd::text not in ('NaN','Infinity','-Infinity')
 and daily_forecast::text not in ('NaN','Infinity','-Infinity') and daily_cap_usd::text not in ('NaN','Infinity','-Infinity')
 and monthly_cap_usd::text not in ('NaN','Infinity','-Infinity') and free_daily_cap_usd::text not in ('NaN','Infinity','-Infinity'));
alter table public.pi_capacity_snapshots add constraint pi_supply_snapshot_finite check (
 available::text not in ('NaN','Infinity','-Infinity') and reserved::text not in ('NaN','Infinity','-Infinity') and pending::text not in ('NaN','Infinity','-Infinity'));
alter table public.pi_paid_operations add constraint pi_supply_operation_finite check (
 reserved_usd::text not in ('NaN','Infinity','-Infinity') and committed_usd::text not in ('NaN','Infinity','-Infinity') and capacity_units::text not in ('NaN','Infinity','-Infinity'));
alter table public.pi_supply_job_reservations add constraint pi_supply_job_finite check (
 reserved_units::text not in ('NaN','Infinity','-Infinity') and reserved_usd::text not in ('NaN','Infinity','-Infinity')
 and consumed_units::text not in ('NaN','Infinity','-Infinity') and consumed_usd::text not in ('NaN','Infinity','-Infinity'));
