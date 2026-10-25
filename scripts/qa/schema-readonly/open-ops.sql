-- READ-ONLY aggregates of the open paid operations (no ids, no user data). Run inside BEGIN TRANSACTION READ ONLY … ROLLBACK.
\pset footer off
\pset format unaligned
\pset fieldsep ' | '
select 'session_read_only', current_setting('transaction_read_only');
with o as (
  select j->>'status' status, coalesce(j->>'provider', '?') provider,
         case when j->>'project_id' like 'podcast-%' then 'podcast' when j->>'project_id' like 'reel-%' then 'reel'
              when j->>'project_id' ~ '^[0-9a-f-]{36}$' then 'uuid' when j->>'project_id' is null then '(null)'
              else split_part(j->>'project_id', '-', 1) end kind,
         coalesce(j->>'method', '?') method,
         coalesce((j->>'reserved_usd')::numeric, 0) reserved, coalesce((j->>'committed_usd')::numeric, 0) committed,
         (j->>'created_at')::timestamptz created, coalesce((j->>'updated_at')::timestamptz, (j->>'created_at')::timestamptz) updated
  from (select to_jsonb(p) j from public.pi_paid_operations p) x
  where j->>'status' in ('RESERVED', 'SUBMITTED', 'PROVIDER_JOB_RECORDED', 'RECONCILIATION_REQUIRED'))
select 'open', status, provider, kind, method, count(*), round(sum(reserved), 4), round(sum(committed), 4),
       case when max(updated) > now() - interval '1 day' then '<1d' when max(updated) > now() - interval '7 days' then '1-7d' else '>7d' end newest_update,
       case when min(created) > now() - interval '1 day' then '<1d' when min(created) > now() - interval '7 days' then '1-7d' else '>7d' end oldest_created
from o group by 2, 3, 4, 5 order by 2, 3, 4, 5;
select 'open_total', count(*), round(sum(coalesce((to_jsonb(p)->>'reserved_usd')::numeric, 0)), 4)
  from public.pi_paid_operations p where p.status in ('RESERVED', 'SUBMITTED', 'PROVIDER_JOB_RECORDED', 'RECONCILIATION_REQUIRED');
select 'open_job_reservations', coalesce(provider, '?'), count(*), round(sum(reserved_usd - consumed_usd), 4)
  from public.pi_supply_job_reservations where status = 'OPEN' group by 2 order by 2;
