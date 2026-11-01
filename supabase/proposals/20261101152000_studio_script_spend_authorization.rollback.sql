-- Rollback of PROPOSAL 20261101152000_studio_script_spend_authorization.sql (NOT APPLIED).
-- Restores the previous pi_submit_with_supply. Keeps the three studio-script tables and their
-- immutability triggers (audit trail). Drop those tables manually only if they are empty and
-- the review explicitly accepts losing the trail. Do not run this against production unless
-- that same review authorized the forward migration.
begin;

do $$ begin
  if to_regprocedure('public.pi_submit_with_supply_pre_studio_script(text,numeric)') is not null then
    drop function if exists public.pi_submit_with_supply(text, numeric);
    alter function public.pi_submit_with_supply_pre_studio_script(text, numeric) rename to pi_submit_with_supply;
  end if;
end $$;

revoke all on function public.pi_submit_with_supply(text, numeric) from public, anon, authenticated;
grant execute on function public.pi_submit_with_supply(text, numeric) to service_role;

drop function if exists public.pi_bind_studio_script_authorization(uuid, uuid, uuid);
drop function if exists public.pi_expire_studio_script_authorizations();
drop function if exists public.pi_close_studio_script_authorization(uuid, uuid);
drop function if exists public.pi_studio_script_authorization_usage(text, text);
drop function if exists public.pi_open_studio_script_authorization(uuid, uuid, numeric, text, numeric);
drop function if exists public.pi_studio_script_project(uuid, uuid);

commit;
