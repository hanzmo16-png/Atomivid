-- O2 contingency, step 2 of 2. Runs ONLY after step 1, supabase/proposals/20261024120000_resume_authorization_ref_match.rollback.sql
-- (sha256 89d82016…), when O2's post-verification failed. Step 1 restores the PR198 function bodies but not one grant:
-- 120000 revokes EXECUTE on the trigger function from service_role and the audited rollback never re-grants it. This file
-- restores that grant (the pre-O2 production ACL is {postgres, service_role}; o2.sh requires it before O2 runs) and removes
-- the registry row that apply-supabase-migration.ts inserted. One transaction; refuses unless step 1 already ran.
begin;
do $$ begin
  if exists (select 1 from pg_proc where oid = 'public.pi_documentary_resume_requires_budget()'::regprocedure
             and (prosecdef or pg_get_functiondef(oid) like '%r.authorization_ref = b.authorization_ref%')) then
    raise exception 'O2 CONTINGENCIA: precondition failed — run the 120000 rollback (step 1) first'; end if;
end $$;
grant execute on function public.pi_documentary_resume_requires_budget() to service_role;
delete from public._migrations_applied where name = '20261024120000_resume_authorization_ref_match.sql';
do $$ begin
  if exists (select 1 from public._migrations_applied where name = '20261024120000_resume_authorization_ref_match.sql')
     or not has_function_privilege('service_role', 'public.pi_documentary_resume_requires_budget()', 'EXECUTE') then
    raise exception 'O2 CONTINGENCIA: post-check failed'; end if;
end $$;
commit;
