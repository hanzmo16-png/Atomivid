-- O3 contingency, step 2 of 2. Runs ONLY after step 1, supabase/proposals/20261024130000_spend_authorization_baseline_fix.rollback.sql
-- (sha256 5d7a3b1f…), when O3's post-verification failed. Step 1 restores the PR198 body of pi_open_spend_authorization (the
-- rollback re-declares the same ACL, so no grant is needed); this removes the registry row apply-supabase-migration.ts inserted.
-- One transaction; refuses unless step 1 already ran (the 130000 body is gone).
begin;
do $$ begin
  if exists (select 1 from pg_proc where oid = 'public.pi_open_spend_authorization(uuid,numeric,text)'::regprocedure
             and pg_get_functiondef(oid) like '%status <> ''RESERVED''%') then
    raise exception 'O3 CONTINGENCIA: precondition failed — run the 130000 rollback (step 1) first'; end if;
end $$;
delete from public._migrations_applied where name = '20261024130000_spend_authorization_baseline_fix.sql';
do $$ begin
  if exists (select 1 from public._migrations_applied where name = '20261024130000_spend_authorization_baseline_fix.sql')
     or not has_function_privilege('service_role', 'public.pi_open_spend_authorization(uuid,numeric,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.pi_open_spend_authorization(uuid,numeric,text)', 'EXECUTE') then
    raise exception 'O3 CONTINGENCIA: post-check failed'; end if;
end $$;
commit;
