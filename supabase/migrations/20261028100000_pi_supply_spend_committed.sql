-- pi_supply_spend counts a COMMITTED call at what it really cost (rollback: supabase/proposals/20261028100000_pi_supply_spend_committed.rollback.sql).
-- Before: every row counted greatest(reserved_usd, committed_usd), so a settled call kept its whole upper-bound
-- reservation as spend. Real case 2026-10-27 (Anthropic, daily window): 20 COMMITTED calls with USD 14.5496 reserved
-- and USD 1.1009 committed → the day showed USD 14.55 spent instead of USD 1.10.
-- After: COMMITTED → committed_usd (reserved_usd only if committed is unknown). Calls still in flight or uncertain
-- (SUBMITTED, PROVIDER_JOB_RECORDED, RECONCILIATION_REQUIRED) and refunds not yet reconciled keep the conservative
-- greatest(reserved, committed). No limit, policy or row changes; only the arithmetic of a COMMITTED row.
create or replace function public.pi_supply_spend(p_provider text,p_start timestamptz) returns numeric
language sql security invoker set search_path='' as $$
 select coalesce((select sum(case when status='COMMITTED' then coalesce(committed_usd,reserved_usd)
                                  else greatest(reserved_usd,coalesce(committed_usd,0)) end) from public.pi_paid_operations
 where (p_provider is null or provider=p_provider) and method<>'capacity_hold'
 and (status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')
 or (created_at>=p_start and (status='COMMITTED' or (status='REFUNDED' and not supply_reconciled))))),0)
 +coalesce((select sum(reserved_usd-consumed_usd) from public.pi_supply_job_reservations
 where (p_provider is null or provider=p_provider) and status='OPEN'),0);
$$;
