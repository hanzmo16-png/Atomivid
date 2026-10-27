-- O8 contingency, step 2 of 2: remove the 20261024140000 registry row. Runs ONLY after step 1 (guard + audited 140000
-- rollback) succeeded. One transaction; refuses to touch the registry unless the 140000 objects are gone and the supply
-- functions are back to their 20261005150229 bodies; afterwards re-checks the row and the access by role.
begin;
do $$
begin
  if to_regclass('public.podcast_studio_episodes') is not null or to_regclass('public.podcast_studio_operations') is not null
     or to_regprocedure('public.pi_supply_state_pre_studio(text)') is not null
     or to_regprocedure('public.pi_studio_call_counts(text,timestamptz,text)') is not null
     or to_regprocedure('public.podcast_studio_operations_cap()') is not null
     or (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.pi_supply_state(text)')) is distinct from '5057aaf5d48eba5e4ad84f09dad0c13b'
     or (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.pi_supply_spend(text,timestamptz)')) is distinct from '15f511954308de9468c448d9b75c6419' then
    raise exception 'O8 CONTINGENCIA: precondition failed (140000 objects still present or supply bodies not restored); run step 1 first';
  end if;
end $$;
delete from public._migrations_applied where name = '20261024140000_podcast_v3_studio.sql';
do $$
begin
  if exists (select 1 from public._migrations_applied where name = '20261024140000_podcast_v3_studio.sql') then
    raise exception 'O8 CONTINGENCIA: registry row still present';
  end if;
  if not has_function_privilege('service_role', 'public.pi_supply_state(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.pi_supply_state(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.pi_supply_state(text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.pi_supply_spend(text,timestamptz)', 'EXECUTE')
     or has_function_privilege('anon', 'public.pi_supply_spend(text,timestamptz)', 'EXECUTE') then
    raise exception 'O8 CONTINGENCIA: supply function access by role not as before';
  end if;
end $$;
commit;
