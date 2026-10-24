-- Reversión de la propuesta Podcast 3.0. Solo borra las tablas nuevas (no toca podcast_episodes).
-- ATENCIÓN: borra episodios de estudio y su libro de operaciones; exporta antes si hubo uso real.
-- First restore pi_supply_spend exactly as in 20261005150229 (it reads podcast_studio_operations).
create or replace function public.pi_supply_spend(p_provider text,p_start timestamptz) returns numeric
language sql security invoker set search_path='' as $$
 select coalesce((select sum(greatest(reserved_usd,coalesce(committed_usd,0))) from public.pi_paid_operations
 where (p_provider is null or provider=p_provider) and method<>'capacity_hold'
 and (status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
 or (created_at>=p_start and (status='COMMITTED' or (status='REFUNDED' and not supply_reconciled))))),0)
 +coalesce((select sum(reserved_usd-consumed_usd) from public.pi_supply_job_reservations
 where (p_provider is null or provider=p_provider) and status='OPEN'),0);
$$;
drop table if exists public.podcast_studio_operations;
drop function if exists public.podcast_studio_operations_cap();
drop table if exists public.podcast_studio_episodes;
