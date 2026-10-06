-- Durable owner-scoped preparation, separate from media production/approval.
create table public.documentary_script_jobs (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 input_hash text not null,
 topic text not null,
 input jsonb,
 status text not null default 'queued' check(status in ('queued','running','completed','failed')),
 stage text not null default 'En cola',
 error_message text,
 request_id uuid not null default gen_random_uuid(),
 run_token uuid,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(user_id,input_hash), unique(request_id)
);
alter table public.documentary_script_jobs enable row level security;
revoke all on public.documentary_script_jobs from public,anon,authenticated;
grant select on public.documentary_script_jobs to authenticated;
grant all on public.documentary_script_jobs to service_role;
create policy documentary_jobs_owner_read on public.documentary_script_jobs for select to authenticated using(user_id=(select auth.uid()));
create index documentary_jobs_owner_created on public.documentary_script_jobs(user_id,created_at desc);

-- Both render and script admissions lock the SAME global policy row. A running
-- or interrupted worker never silently loses its slot on a timer.
create or replace function public.pi_worker_supply_slots() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare g public.pi_supply_policies%rowtype; active integer;
begin
 select * into g from public.pi_supply_policies where provider='__global__';
 select (select count(*) from public.video_requests where status='processing' and progress_stage is not null and progress_stage<>'queued')
  +(select count(*) from public.documentary_script_jobs where status='running') into active;
 return jsonb_build_object('configured',g.enabled and g.max_concurrent>0,'active',active,
 'free',case when g.enabled and g.max_concurrent>0 then greatest(0,g.max_concurrent-active) else 0 end);
end $$;
create function public.claim_documentary_script_job(p_id uuid,p_token uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j public.documentary_script_jobs%rowtype; slots jsonb;
begin
 perform 1 from public.pi_supply_policies where provider='__global__' for update;
 select * into j from public.documentary_script_jobs where id=p_id for update;
 if not found then return jsonb_build_object('state','missing'); end if;
 if j.status<>'queued' then return jsonb_build_object('state',j.status); end if;
 if j.input is null then return jsonb_build_object('state','failed'); end if;
 slots:=public.pi_worker_supply_slots();
 if coalesce((slots->>'free')::integer,0)<=0 then return jsonb_build_object('state','waiting'); end if;
 update public.documentary_script_jobs set status='running',run_token=p_token,error_message=null,updated_at=clock_timestamp() where id=p_id;
 return jsonb_build_object('state','claimed');
end $$;

create function public.finish_documentary_script_job(p_id uuid,p_token uuid,p_script jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare j public.documentary_script_jobs%rowtype;
begin
 select * into j from public.documentary_script_jobs where id=p_id and status='running' and run_token=p_token for update;
 if not found then raise exception 'script job ownership lost'; end if;
 if p_script->'editorial'->>'status' is distinct from 'approved' or jsonb_array_length(p_script->'beats')<5 then
  raise exception 'editorial approval required'; end if;
 insert into public.video_requests(id,user_id,topic,style,duration_seconds,language,mode,aspect_ratio,script_json,status)
 values(j.request_id,j.user_id,j.topic,'Documental',(j.input->'fields'->>'durationMinutes')::numeric*60,
 j.input->'fields'->>'language','long_form','16:9',p_script,'script_ready');
 update public.documentary_script_jobs set status='completed',stage='Guion listo',run_token=null,updated_at=clock_timestamp() where id=p_id;
end $$;
revoke all on function public.claim_documentary_script_job(uuid,uuid),public.finish_documentary_script_job(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.claim_documentary_script_job(uuid,uuid),public.finish_documentary_script_job(uuid,uuid,jsonb) to service_role;
