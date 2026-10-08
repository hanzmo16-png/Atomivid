-- Operator-only, explicitly authorized resumption of the SAME closed budget.
-- Cap, original baseline and all accumulated spend remain immutable.
create table if not exists public.pi_recovery_resume_authorizations (
 project_id text not null references public.pi_recovery_budgets(project_id),
 authorization_ref text not null check(length(trim(authorization_ref))>0),
 transaction_id bigint not null default txid_current(),
 authorized_at timestamptz not null default clock_timestamp(),
 primary key(project_id,authorization_ref)
);
alter table public.pi_recovery_resume_authorizations enable row level security;
revoke all on public.pi_recovery_resume_authorizations from public,anon,authenticated,service_role;
create or replace function public.pi_recovery_budget_guard() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'recovery budgets cannot be deleted'; end if;
 if new.project_id is distinct from old.project_id or new.job_id is distinct from old.job_id
 or new.owner_id is distinct from old.owner_id or new.cap_usd is distinct from old.cap_usd
 or new.baseline_keys is distinct from old.baseline_keys or new.authorization_ref is distinct from old.authorization_ref
 or new.created_at is distinct from old.created_at then raise exception 'recovery budget is immutable'; end if;
 if old.status='CLOSED' and new.status<>'CLOSED' then
  if current_setting('atomivid.recovery_resume_project',true) is distinct from old.project_id
   or not exists(select 1 from public.pi_recovery_resume_authorizations where project_id=old.project_id and transaction_id=txid_current())
  then raise exception 'a closed recovery budget requires explicit operator authorization'; end if;
 end if;
 return new;
end $$;
create or replace function public.pi_resume_recovery_budget(p_job_id uuid,p_authorization_ref text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.pi_recovery_budgets%rowtype; j public.documentary_script_jobs%rowtype; usage jsonb;
begin
 if p_authorization_ref is null or length(trim(p_authorization_ref))=0 then raise exception 'authorization required'; end if;
 select * into b from public.pi_recovery_budgets where job_id=p_job_id for update;
 if not found then raise exception 'budget not found'; end if;
 if exists(select 1 from public.pi_recovery_resume_authorizations where project_id=b.project_id and authorization_ref=p_authorization_ref)
 then return jsonb_build_object('resumed',false,'reason','authorization already used','usage',public.pi_recovery_budget_usage(b.project_id)); end if;
 select * into j from public.documentary_script_jobs where id=p_job_id for update;
 if j.status<>'failed' or j.run_token is not null or j.user_id<>b.owner_id then raise exception 'failed owner job required'; end if;
 if b.status<>'CLOSED' then raise exception 'budget is not closed'; end if;
 usage:=public.pi_recovery_budget_usage(b.project_id);
 if (usage->>'pendingUsd')::numeric<>0 then raise exception 'uncertain operations must be reconciled'; end if;
 if (usage->>'remainingUsd')::numeric<=0 then raise exception 'budget exhausted'; end if;
 insert into public.pi_recovery_resume_authorizations(project_id,authorization_ref) values(b.project_id,p_authorization_ref);
 perform set_config('atomivid.recovery_resume_project',b.project_id,true);
 update public.pi_recovery_budgets set status='ACTIVE',closed_at=null where project_id=b.project_id;
 perform set_config('atomivid.recovery_resume_project','',true);
 return jsonb_build_object('resumed',true,'usage',public.pi_recovery_budget_usage(b.project_id));
end $$;
revoke all on function public.pi_resume_recovery_budget(uuid,text) from public,anon,authenticated,service_role;
