-- Owner authorized persistent manual balances on 2026-10-06.
-- This changes observation expiry only: no snapshot timestamps, balances,
-- policies, reserves, job states or ledger accounting are rewritten.
create or replace function public.pi_supply_balance_is_fresh(
 p_reliability text, p_checked_at timestamptz, p_now timestamptz
) returns boolean language sql immutable security invoker set search_path = '' as $$
 select coalesce(
  p_reliability in ('provider_api','manual_entry')
  and isfinite(p_checked_at) and isfinite(p_now)
  and p_checked_at <= p_now
  and (p_reliability='manual_entry' or p_checked_at >= p_now - interval '5 minutes'),
  false);
$$;
revoke all on function public.pi_supply_balance_is_fresh(text,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.pi_supply_balance_is_fresh(text,timestamptz,timestamptz) to service_role;

-- Abort atomically if the live supply gate no longer uses this helper.
do $migration$
begin
 if position('pi_supply_balance_is_fresh' in pg_get_functiondef('public.pi_supply_state_without_jobs(text)'::regprocedure))=0 then
  raise exception 'Supply gate is not connected to the observation policy';
 end if;
 if not public.pi_supply_balance_is_fresh('manual_entry','2000-01-01Z','2026-10-06Z')
  or public.pi_supply_balance_is_fresh('provider_api','2026-10-06 00:00:00Z','2026-10-06 00:05:01Z')
  or not public.pi_supply_balance_is_fresh('provider_api','2026-10-06 00:00:00Z','2026-10-06 00:05:00Z')
  or public.pi_supply_balance_is_fresh('manual_entry','2026-10-07Z','2026-10-06Z')
  or public.pi_supply_balance_is_fresh('manual_entry','-infinity','2026-10-06Z')
  or public.pi_supply_balance_is_fresh('manual_entry','2026-10-06Z','infinity')
  or public.pi_supply_balance_is_fresh('manual_entry',null,'2026-10-06Z')
  or public.pi_supply_balance_is_fresh('none','2026-10-06Z','2026-10-06Z') then
  raise exception 'Balance observation policy regression';
 end if;
end
$migration$;
