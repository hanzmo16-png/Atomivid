-- Verifies 0029 on a local Postgres (run after 06; roles anon/authenticated/service_role come from 00).
-- Every expectation raises on failure. The test simulates Supabase's default privileges (ALL on every new
-- public object to anon/authenticated/service_role — exactly what the production preflight observed), then
-- re-applies 0029 to prove it is idempotent and that the revokes act on real grants.
\set ON_ERROR_STOP on
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'OK: % rejected (%)', label, sqlerrm; return; end;
  raise exception 'SECURITY/INTEGRITY FAILURE: % was accepted', label;
end $$;

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'owner-a@test.local'),
  ('44444444-4444-4444-4444-444444444444', 'owner-b@test.local') on conflict do nothing;

-- Row counts of the six production tables before the (second) application of 0029.
create temp table sec_counts_before as
select 'video_requests' as t, count(*) as n from public.video_requests union all
select 'generation_costs', count(*) from public.generation_costs union all
select 'subscriptions', count(*) from public.subscriptions union all
select 'avatars', count(*) from public.avatars union all
select 'user_voices', count(*) from public.user_voices union all
select 'tts_jobs', count(*) from public.tts_jobs;

-- Simulate Supabase default privileges seen in production (preflight): ALL to the three API roles.
grant all on public.yt_video_experiment to anon, authenticated, service_role;
grant all on public._migrations_applied to anon, authenticated, service_role;
grant select on public.yt_video_links, public.yt_performance_snapshots, public.fc_master_metrics to anon, authenticated, service_role;

-- Idempotency: apply 0029 again on a database where it already ran.
\i supabase/migrations/0029_database_security_hardening.sql

-- 1. View: security_invoker on, no client privilege left, service_role untouched.
do $$
declare opts text[]; begin
  select reloptions into opts from pg_class where oid = 'public.yt_video_experiment'::regclass;
  if not exists (select 1 from unnest(opts) o where lower(o) in ('security_invoker=true', 'security_invoker=on')) then
    raise exception 'yt_video_experiment is not security_invoker: %', opts;
  end if;
  if has_table_privilege('anon', 'public.yt_video_experiment', 'select') then raise exception 'anon can still select yt_video_experiment'; end if;
  if has_table_privilege('authenticated', 'public.yt_video_experiment', 'select, insert, update, delete') then raise exception 'authenticated still has privileges on yt_video_experiment'; end if;
  if not has_table_privilege('service_role', 'public.yt_video_experiment', 'select') then raise exception 'service_role lost select on yt_video_experiment'; end if;
  raise notice 'OK: yt_video_experiment is security_invoker and backend-only';
end $$;

-- 2. Registry: RLS on, zero policies, no client privilege, owner (runner) and service_role keep working.
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public._migrations_applied'::regclass) then raise exception 'RLS not enabled on _migrations_applied'; end if;
  if (select count(*) from pg_policy where polrelid = 'public._migrations_applied'::regclass) <> 0 then raise exception '_migrations_applied must have no policies'; end if;
  if has_table_privilege('anon', 'public._migrations_applied', 'select, insert, update, delete') then raise exception 'anon still has privileges on _migrations_applied'; end if;
  if has_table_privilege('authenticated', 'public._migrations_applied', 'select, insert, update, delete') then raise exception 'authenticated still has privileges on _migrations_applied'; end if;
  if not has_table_privilege('service_role', 'public._migrations_applied', 'select') then raise exception 'service_role lost select on _migrations_applied'; end if;
  -- No permissive policy anywhere on the hardened objects or the tables behind the view.
  if exists (select 1 from pg_policy where polrelid in ('public._migrations_applied'::regclass, 'public.yt_video_links'::regclass, 'public.yt_performance_snapshots'::regclass, 'public.fc_master_metrics'::regclass)
             and (pg_get_expr(polqual, polrelid) = 'true' or pg_get_expr(polwithcheck, polrelid) = 'true')) then raise exception 'a USING (true) / WITH CHECK (true) policy exists'; end if;
  raise notice 'OK: _migrations_applied has RLS, no policies, no client grants';
end $$;
-- Migration runner compatibility: the table owner (what the runner connects as) still registers and reads migrations.
insert into public._migrations_applied (name) values ('9999_verify_probe.sql') on conflict (name) do nothing;
do $$ begin
  if (select count(*) from public._migrations_applied where name = '9999_verify_probe.sql') <> 1 then raise exception 'owner cannot read its own registry row'; end if;
end $$;
delete from public._migrations_applied where name = '9999_verify_probe.sql';

-- 3. Client roles: denied on the view, the registry, and PI / Final Cut / YouTube internal tables.
set role anon;
select pg_temp.expect_fail($$select count(*) from public.yt_video_experiment$$, 'anon reading yt_video_experiment');
select pg_temp.expect_fail($$select count(*) from public._migrations_applied$$, 'anon reading _migrations_applied');
select pg_temp.expect_fail($$insert into public._migrations_applied (name) values ('evil.sql')$$, 'anon writing _migrations_applied');
reset role;
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
select pg_temp.expect_fail($$select count(*) from public.yt_video_experiment$$, 'authenticated reading yt_video_experiment');
select pg_temp.expect_fail($$select count(*) from public._migrations_applied$$, 'authenticated reading _migrations_applied');
select pg_temp.expect_fail($$insert into public._migrations_applied (name) values ('evil.sql')$$, 'authenticated writing _migrations_applied');
select pg_temp.expect_fail($$delete from public._migrations_applied$$, 'authenticated deleting _migrations_applied');
reset role;
-- service_role (backend) keeps reading both (BYPASSRLS + untouched grants).
set role service_role;
select count(*) as service_role_registry_rows from public._migrations_applied;
select count(*) as service_role_experiment_rows from public.yt_video_experiment;
reset role;

-- 4. Invoker semantics: even if an operator deliberately grants the view to clients again, RLS of the
--    underlying tables applies to the caller (owner B sees nothing), unlike definer semantics.
insert into public.yt_video_links (link_key, project_id, request_id, master_checksum_sha256, master_storage_path, channel_id, video_id, linked_at, linked_by, status)
values ('p1:dQw4w9WgXcQ', 'p1', null, '28c0e1b662d1b9c9299996bdc68abf9bafa40813b79caf1b5b9a2aab4229841f', 'p1/final/master.mp4', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'dQw4w9WgXcQ', now(), 'producer', 'linked')
on conflict do nothing;
grant select on public.yt_video_experiment to authenticated;
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
do $$ begin
  if (select count(*) from public.yt_video_experiment) <> 0 then raise exception 'owner B sees experiment rows of owner A through the view'; end if;
  raise notice 'OK: security_invoker view enforces the underlying RLS for the caller';
end $$;
reset role;
do $$ begin
  if (select count(*) from public.yt_video_experiment) < 1 then raise exception 'owner sees no experiment rows (view broken)'; end if;
end $$;
revoke all on public.yt_video_experiment from anon, authenticated;
revoke select on public.yt_video_links, public.yt_performance_snapshots, public.fc_master_metrics from anon, authenticated;

-- 5. Functions: exactly the six, pinned search_path, never SECURITY DEFINER, bodies untouched (still plpgsql triggers).
do $$
declare n int; begin
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public'
     and p.proname in ('enforce_tts_monthly_limit', 'enforce_user_voice_limits', 'pi_reject_mutation', 'pi_paid_operation_forward_only', 'fc_append_only', 'yt_snapshot_final')
     and p.prosecdef = false
     and p.proconfig @> array['search_path=pg_catalog, public']
     and p.prorettype = 'trigger'::regtype;
  if n <> 6 then raise exception 'expected 6 hardened trigger functions, found %', n; end if;
  if exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.prosecdef) then raise exception 'a SECURITY DEFINER function exists in public'; end if;
  raise notice 'OK: six trigger functions have search_path = pg_catalog, public';
end $$;

-- 6. Triggers still fire with the pinned search_path — including from a session whose own search_path is hostile/empty.
set search_path = pg_catalog;
insert into public.pi_telemetry_events (event_id, type, project_id, payload) values ('e_sec', 'attempt', 'p1', '{}') on conflict do nothing;
select pg_temp.expect_fail($$update public.pi_telemetry_events set payload = '{"x":1}' where event_id = 'e_sec'$$, 'updating telemetry (pi_reject_mutation)');
insert into public.pi_paid_operations (idempotency_key, project_id, shot_id, provider, model, method, attempt_kind, reserved_usd, status)
values ('op_sec', 'p1', 'S1', 'runway', 'gen4_turbo', 'I2V_ECONOMY', 'initial', 0.25, 'RESERVED') on conflict do nothing;
update public.pi_paid_operations set status = 'SUBMITTED' where idempotency_key = 'op_sec';
select pg_temp.expect_fail($$update public.pi_paid_operations set status = 'RESERVED' where idempotency_key = 'op_sec'$$, 'moving a paid operation backwards (pi_paid_operation_forward_only)');
select pg_temp.expect_fail($$delete from public.pi_paid_operations where idempotency_key = 'op_sec'$$, 'deleting a paid operation (pi_reject_mutation)');
insert into public.fc_inspections (report_id, master_id, production_id, inspection_version, policy_version, mode, source_kind, source_ref, input_sha256, verdict, technical, editorial, opening, counts)
values ('fcr_sec', 'm1', 'p1', 'final-cut-inspection/1', 'final-cut-policy/1', 'INSPECT_ONLY', 'edit_timeline', 'sb.json', repeat('a', 64), 'PASS', '{}', '{}', '{}', '{}') on conflict do nothing;
select pg_temp.expect_fail($$update public.fc_inspections set verdict = 'REPAIR_REQUIRED' where report_id = 'fcr_sec'$$, 'editing an inspection (fc_append_only)');
insert into public.yt_performance_snapshots (snapshot_key, channel_id, video_id, "window", due_at, status, collected_at, metrics, source)
values ('yts_sec', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'dQw4w9WgXcQ', '48h', now(), 'COLLECTED', now(), '{"views":1}', 'youtube-analytics-v2') on conflict do nothing;
select pg_temp.expect_fail($$update public.yt_performance_snapshots set metrics = '{"views":999}' where snapshot_key = 'yts_sec'$$, 'rewriting a COLLECTED snapshot (yt_snapshot_final)');
-- TTS monthly limit: first job fits, second exceeds (trigger logic intact, not just "does not crash").
insert into public.tts_jobs (user_id, client_request_id, title, language, voice_choice, voice_label, script, characters, max_chars_per_month)
values ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Sec test', 'es', 'v', 'V', 'hola', 60, 100);
select pg_temp.expect_fail($$insert into public.tts_jobs (user_id, client_request_id, title, language, voice_choice, voice_label, script, characters, max_chars_per_month) values ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'Sec test 2', 'es', 'v', 'V', 'hola', 60, 100)$$, 'a TTS job over the monthly limit (enforce_tts_monthly_limit)');
-- Voice limits: one voice allowed per user, second rejected.
insert into public.user_voices (user_id, client_request_id, name, consent_version, consent_at, max_voices_per_user, max_voices_total)
values ('33333333-3333-3333-3333-333333333333', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'Voice A', 'v1', now(), 1, 10);
select pg_temp.expect_fail($$insert into public.user_voices (user_id, client_request_id, name, consent_version, consent_at, max_voices_per_user, max_voices_total) values ('33333333-3333-3333-3333-333333333333', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'Voice B', 'v1', now(), 1, 10)$$, 'a second voice over the per-user limit (enforce_user_voice_limits)');
reset search_path;

-- 7. Data integrity: applying 0029 changed no row count (the trigger probes above are the only inserts, done after).
do $$
declare bad text; begin
  select string_agg(t || ': ' || n::text, ', ') into bad from sec_counts_before b
   where n <> case t
     when 'video_requests' then (select count(*) from public.video_requests)
     when 'generation_costs' then (select count(*) from public.generation_costs)
     when 'subscriptions' then (select count(*) from public.subscriptions)
     when 'avatars' then (select count(*) from public.avatars)
     when 'user_voices' then (select count(*) from public.user_voices) - 1
     when 'tts_jobs' then (select count(*) from public.tts_jobs) - 1 end;
  if bad is not null then raise exception 'row counts changed unexpectedly: %', bad; end if;
  raise notice 'OK: row counts unchanged by 0029';
end $$;

select 'ALL DATABASE SECURITY HARDENING CHECKS PASSED' as result;
