-- Rollback of 20261028100000: restores the LIVE definition from 20261024140000_podcast_v3_studio (byte-identical body).
create or replace function public.pi_supply_spend(p_provider text,p_start timestamptz) returns numeric
language sql security invoker set search_path='' as $$
 select coalesce((select sum(greatest(reserved_usd,coalesce(committed_usd,0))) from public.pi_paid_operations
 where (p_provider is null or provider=p_provider) and method<>'capacity_hold'
 and (status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
 or (created_at>=p_start and (status='COMMITTED' or (status='REFUNDED' and not supply_reconciled))))),0)
 +coalesce((select sum(reserved_usd-consumed_usd) from public.pi_supply_job_reservations
 where (p_provider is null or provider=p_provider) and status='OPEN'),0)
 -- Podcast Studio (own ledger): open reservations/uncertain always count; settled count from p_start (actual cost).
 +coalesce((select sum(case when s.state='settled' then greatest(s.reserved_usd,coalesce(s.actual_usd,0)) else s.reserved_usd end)
 from public.podcast_studio_operations s where (p_provider is null or s.provider=p_provider)
 and (s.state in ('reserved','uncertain') or (s.state='settled' and s.created_at>=p_start))),0);
$$;
