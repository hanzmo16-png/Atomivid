-- READ-ONLY catalog audit (no DDL, no DML). run.sh wraps it in BEGIN TRANSACTION READ ONLY … ROLLBACK.
\pset footer off
\pset format unaligned
\pset fieldsep ' | '
select 'session_read_only', current_setting('default_transaction_read_only'), current_setting('transaction_read_only');
select 'server', current_setting('server_version'), pg_is_in_recovery();
select 'migration', version from supabase_migrations.schema_migrations where version >= '20261015' order by version;
-- full registry (version|name) for history.py
select 'registered', m.version, coalesce(to_jsonb(m)->>'name', '') from supabase_migrations.schema_migrations m order by m.version;
select 'table', t, to_regclass('public.'||t) is not null from unnest(array['pi_spend_authorizations','pi_recovery_resume_authorizations','pi_recovery_budgets',
  'pi_paid_operations','pi_supply_policies','podcast_episodes','documentary_script_jobs','podcast_studio_episodes','podcast_studio_operations']) t;
select 'function', p.oid::regprocedure::text, p.prosecdef as secdef, coalesce(array_to_string(p.proconfig, ','), '') as config, pg_get_userbyid(p.proowner) owner, md5(pg_get_functiondef(p.oid)) def_md5
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('pi_open_spend_authorization','pi_spend_authorization_usage',
  'pi_submit_with_supply','pi_supply_state','pi_supply_state_pre_studio','pi_supply_spend','pi_studio_call_counts','pi_documentary_resume_requires_budget',
  'pi_recovery_resume_authorization','podcast_studio_operations_cap') order by 2;
-- markers: which proposal is already in production
select 'marker 20261024000000 submit refuses podcast without authorization', coalesce(bool_or(pg_get_functiondef(p.oid) like '%authorization missing%'), false)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='pi_submit_with_supply';
select 'marker 20261024130000 baseline excludes RESERVED', coalesce(bool_or(pg_get_functiondef(p.oid) like '%status <> ''RESERVED''%'), false)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='pi_open_spend_authorization';
select 'marker 20261024120000 trigger joins authorization_ref', coalesce(bool_or(pg_get_functiondef(p.oid) like '%r.authorization_ref = b.authorization_ref%'), false)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='pi_documentary_resume_requires_budget';
select 'marker 20261024140000 pi_supply_state wrapped', to_regprocedure('public.pi_supply_state_pre_studio(text)') is not null;
select 'trigger', tgrelid::regclass::text, tgname, tgenabled from pg_trigger where not tgisinternal and tgname in ('pi_documentary_resume_requires_budget','pi_spend_authorization_guard','podcast_studio_operations_cap');
-- objects that depend on pi_supply_state BY OID (views, SQL functions with BEGIN ATOMIC, defaults): a rename would keep them on the old function
select 'depends_on_pi_supply_state', d.classid::regclass::text, d.objid, coalesce(c.relname, p.proname) obj
  from pg_depend d left join pg_class c on d.classid='pg_class'::regclass and c.oid=d.objid left join pg_rewrite rw on d.classid='pg_rewrite'::regclass and rw.oid=d.objid
  left join pg_proc p on d.classid='pg_proc'::regclass and p.oid=d.objid
  where d.refobjid = to_regprocedure('public.pi_supply_state(text)');
select 'callers_by_name_pi_supply_state', p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosrc like '%pi_supply_state(%' and p.proname <> 'pi_supply_state' order by 2;
-- column contract #200 relies on
select 'column', table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema='public' and (
  (table_name='podcast_episodes' and column_name in ('budget_usd','run_budget_usd','production','production_timeline','estimated_usd','video_status','video_run_token','video_heartbeat_at','retry_count'))
  or (table_name='pi_spend_authorizations') or (table_name='pi_recovery_resume_authorizations')) order by 2,3;
-- privileges
select 'privilege', r.rolname, f, has_function_privilege(r.rolname, f, 'execute') from (values ('public.pi_open_spend_authorization(uuid,numeric,text)'), ('public.pi_spend_authorization_usage(text,text)')) v(f)
  cross join pg_roles r where r.rolname in ('anon','authenticated','service_role') and to_regprocedure(f) is not null order by 2,3;
-- aggregated counts only (no personal data): what a migration would meet
select 'count spend_authorizations', case when to_regclass('public.pi_spend_authorizations') is null then 'table absent'
  else (xpath('/row/c/text()', query_to_xml('select count(*) c from public.pi_spend_authorizations', false, true, '')))[1]::text end;
select 'count podcast ops by status', status, count(*) from public.pi_paid_operations where project_id like 'podcast-%' group by status order by 2;
select 'count podcast episodes', count(*), count(*) filter (where budget_usd is not null) from public.podcast_episodes;
