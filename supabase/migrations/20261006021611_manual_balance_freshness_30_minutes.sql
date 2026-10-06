-- Owner authorized 2026-10-05: manual evidence is valid for 30 minutes.
-- API evidence remains valid for five minutes. Never rewrite observation times.
create or replace function public.pi_supply_balance_is_fresh(
 p_reliability text, p_checked_at timestamptz, p_now timestamptz
) returns boolean language sql immutable security invoker set search_path = '' as $$
 select coalesce(
  p_reliability in ('provider_api','manual_entry')
  and isfinite(p_checked_at) and isfinite(p_now)
  and p_checked_at <= p_now
  and p_checked_at >= p_now - case when p_reliability='manual_entry'
   then interval '30 minutes' else interval '5 minutes' end,
  false);
$$;
revoke all on function public.pi_supply_balance_is_fresh(text,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.pi_supply_balance_is_fresh(text,timestamptz,timestamptz) to service_role;

-- Narrow, guarded replacement preserves all ledger deductions, policy caps,
-- job reservations, permissions and any unrelated changes in the live function.
do $migration$
declare
 definition text := pg_get_functiondef('public.pi_supply_state_without_jobs(text)'::regprocedure);
 old_condition text := $old$s.checked_at > clock_timestamp() or s.checked_at < clock_timestamp()-interval '5 minutes'$old$;
 new_condition text := 'not public.pi_supply_balance_is_fresh(s.reliability, s.checked_at, clock_timestamp())';
begin
 if (length(definition)-length(replace(definition,old_condition,''))) <> length(old_condition) then
  raise exception 'Expected exactly one existing supply freshness check; no change applied';
 end if;
 execute replace(definition,old_condition,new_condition);
end
$migration$;
