-- READ-ONLY aggregates (no personal data): what 120000 / 130000 / 140000 would meet in production.
-- cierre.sh wraps it in BEGIN TRANSACTION READ ONLY … ROLLBACK.
\pset footer off
\pset format unaligned
\pset fieldsep ' | '
select 'session_read_only', current_setting('transaction_read_only');
-- row counts of every table the rehearsal copies (compared with the replica after restore)
select format('select %L, %L, count(*) from public.%I', 'prod_rows', c.relname, c.relname)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and (c.relname like 'pi\_%' or c.relname = '_migrations_applied') order by 1 \gexec
select 'prod_rows', 'supabase_migrations.schema_migrations', count(*) from supabase_migrations.schema_migrations;
-- 120000: exhausted documentary jobs (failed, retry_count >= 3) that the CURRENT trigger lets requeue (project-only join)
-- and how many of those the NEW rule (same project_id + authorization_ref + non-empty transaction_id) would still allow.
select 'impact120000 exhausted_failed_jobs', count(*) from public.documentary_script_jobs j where j.status = 'failed' and j.retry_count >= 3;
select 'impact120000 requeue_allowed_old_rule', count(*) from public.documentary_script_jobs j where j.status = 'failed' and j.retry_count >= 3
  and exists (select 1 from public.pi_recovery_budgets b join public.pi_recovery_resume_authorizations r on r.project_id = b.project_id and r.transaction_id is not null
              where b.job_id = j.id and b.owner_id = j.user_id and b.status = 'ACTIVE');
select 'impact120000 requeue_allowed_new_rule', count(*) from public.documentary_script_jobs j where j.status = 'failed' and j.retry_count >= 3
  and exists (select 1 from public.pi_recovery_budgets b join public.pi_recovery_resume_authorizations r on r.project_id = b.project_id and r.authorization_ref = b.authorization_ref
              where b.job_id = j.id and b.owner_id = j.user_id and b.status = 'ACTIVE' and length(trim(coalesce(b.authorization_ref, ''))) > 0
                and r.transaction_id is not null and length(trim(r.transaction_id::text)) > 0);
select 'impact120000 active_recovery_budgets', count(*) from public.pi_recovery_budgets where status = 'ACTIVE';
-- 130000: podcast projects WITHOUT an authorization yet that hold RESERVED ops (the new baseline no longer hides them)
select 'impact130000 podcast_projects_without_authorization_with_reserved', count(distinct o.project_id) from public.pi_paid_operations o
  where o.project_id like 'podcast-%' and o.status = 'RESERVED' and not exists (select 1 from public.pi_spend_authorizations a where a.project_id = o.project_id);
select 'impact130000 podcast_projects_blocked_by_open_charge', count(distinct o.project_id) from public.pi_paid_operations o
  where o.project_id like 'podcast-%' and o.status in ('SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED');
select 'impact130000 existing_authorizations', count(*) from public.pi_spend_authorizations;
-- 140000: supply state per provider TODAY (the replica must give the same answer before and after 140000)
select 'prod_supply_state', p.provider, md5(public.pi_supply_state(p.provider)::text) from public.pi_supply_policies p order by 2;
select 'impact140000 studio_tables_present', to_regclass('public.podcast_studio_episodes') is not null, to_regclass('public.podcast_studio_operations') is not null;
-- ACLs of every function the three proposals touch (production truth for the privilege checks)
select 'prod_acl', p.oid::regprocedure::text, coalesce(p.proacl::text, '(default: PUBLIC execute)'), has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('pi_documentary_resume_requires_budget','pi_recovery_resume_authorization',
  'pi_open_spend_authorization','pi_spend_authorization_usage','pi_supply_state','pi_supply_spend','pi_submit_with_supply') order by 2;
-- In-flight work at deploy time (the new code would resume it): aggregates only
select 'inflight podcast_episodes video_status', coalesce(video_status, '(null)'), count(*) from public.podcast_episodes group by 2 order by 2;
select 'inflight podcast_episodes scheduled_due_now', count(*) from public.podcast_episodes where video_status = 'scheduled' and scheduled_at <= now();
select 'inflight podcast_episodes scheduled_future', count(*) from public.podcast_episodes where video_status = 'scheduled' and scheduled_at > now();
select 'inflight documentary_script_jobs status', status, count(*) from public.documentary_script_jobs group by 2 order by 2;
select 'inflight video_requests status (last 7 days)', status, count(*) from public.video_requests where created_at > now() - interval '7 days' group by 2 order by 2;
select 'inflight pi_paid_operations open (all projects)', status, count(*) from public.pi_paid_operations where status in ('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED') group by 2 order by 2;
-- rows in the studio ledger (only meaningful after 140000; -1 = tables absent)
select 'impact140000 studio_rows', case when to_regclass('public.podcast_studio_operations') is null or to_regclass('public.podcast_studio_episodes') is null then -1
  else (xpath('/row/c/text()', query_to_xml('select (select count(*) from public.podcast_studio_episodes) + (select count(*) from public.podcast_studio_operations) c', false, true, '')))[1]::text::int end;
