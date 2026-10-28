-- PROPOSAL 20261028100000 (rollback: 20261028100000_pi_supply_spend_committed.rollback.sql): pi_supply_spend counts a
-- settled call at what it really cost. Base = the LIVE definition from 20261024140000_podcast_v3_studio (applied by O8):
-- the pi_paid_operations part, the job reservations part and the Podcast Studio ledger part are kept; only the amount of a
-- settled row changes.
-- Before: every row counted greatest(reserved, committed/actual), so a settled call kept its whole upper-bound reservation.
-- Real case 2026-10-27/28 (Anthropic): 20 COMMITTED calls, USD 14.5496 reserved vs 1.1009 committed; month USD 65.62 vs 7.16.
-- After: COMMITTED → committed_usd (reserved only if the cost is unknown); studio 'settled' → actual_usd (same rule).
-- In-flight/uncertain rows and unreconciled refunds keep the conservative upper bound. No limit, policy or row changes.
create or replace function public.pi_supply_spend(p_provider text,p_start timestamptz) returns numeric
language sql security invoker set search_path='' as $$
 select coalesce((select sum(case when status='COMMITTED' then coalesce(committed_usd,reserved_usd)
                                  else greatest(reserved_usd,coalesce(committed_usd,0)) end) from public.pi_paid_operations
 where (p_provider is null or provider=p_provider) and method<>'capacity_hold'
 and (status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
 or (created_at>=p_start and (status='COMMITTED' or (status='REFUNDED' and not supply_reconciled))))),0)
 +coalesce((select sum(reserved_usd-consumed_usd) from public.pi_supply_job_reservations
 where (p_provider is null or provider=p_provider) and status='OPEN'),0)
 -- Podcast Studio (own ledger): open reservations/uncertain always count; settled count from p_start at their actual cost.
 +coalesce((select sum(case when s.state='settled' then coalesce(s.actual_usd,s.reserved_usd) else s.reserved_usd end)
 from public.podcast_studio_operations s where (p_provider is null or s.provider=p_provider)
 and (s.state in ('reserved','uncertain') or (s.state='settled' and s.created_at>=p_start))),0);
$$;
