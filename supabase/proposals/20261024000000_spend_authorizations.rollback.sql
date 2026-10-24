-- Rollback of the PROPOSAL 20261024000000_spend_authorizations.sql (not applied).
begin;
drop function if exists public.pi_submit_with_supply(text, numeric);
alter function public.pi_submit_with_supply_pre_authz(text, numeric) rename to pi_submit_with_supply;
drop function if exists public.pi_spend_authorization_usage(text, text);
drop function if exists public.pi_open_spend_authorization(uuid, numeric, text);
-- The table is kept (audit trail of authorizations); drop it manually only if it is empty.
commit;
