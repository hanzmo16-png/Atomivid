-- PI V2 Fase B3.2 (RB-06): (1) a completed video_requests row cannot be changed by its owner;
-- (2) clients cannot write public.avatars (migration 0032); the service role still can.
-- Run after 00_stub + every migration (see README). Setup emulates Supabase's default table-level
-- grants and re-applies 0031/0032 on top, as in a real project. A failed expectation raises 'FALLO …'.
\set ON_ERROR_STOP on

grant select, insert, update, delete on public.video_requests, public.avatars to anon, authenticated, service_role;
\ir ../0031_video_request_column_guard.sql
\ir ../0032_avatar_write_guard.sql

insert into auth.users (id, email) values
  ('41414141-4141-4141-8141-414141414141', 'b32-user-a@test.local'),
  ('42424242-4242-4242-8242-424242424242', 'b32-user-b@test.local')
on conflict (id) do nothing;

-- Run one write as the current role; it must change nothing: either refused (42501) or 0 rows.
create or replace function pg_temp.expect_no_write(label text, stmt text) returns void language plpgsql as $$
declare n bigint;
begin
  begin
    execute stmt;
    get diagnostics n = row_count;
  exception when insufficient_privilege then
    raise notice 'ok refused (42501): %', label;
    return;
  end;
  if n <> 0 then raise exception 'FALLO B3.2: % — % row(s) changed', label, n; end if;
  raise notice 'ok no rows changed: %', label;
end $$;

-- ===================== 1. completed video_requests row is frozen for its owner =====================
set role service_role;
insert into public.video_requests (id, user_id, topic, style, duration_seconds, mode, status, render_attempts, video_path, script_json)
values ('aaaa3232-0000-4000-8000-000000000001', '41414141-4141-4141-8141-414141414141', 'tema original', 'Motivacional', 30, 'visual',
        'completed', 1, 'aaaa3232-0000-4000-8000-000000000001/attempt-1/final.mp4', '{"title":"original","segments":[]}'::jsonb);
reset role;

set role authenticated;
set request.jwt.claim.sub = '41414141-4141-4141-8141-414141414141';
select pg_temp.expect_no_write('owner sets completed row back to pending',
  $q$update public.video_requests set status = 'pending' where id = 'aaaa3232-0000-4000-8000-000000000001'$q$);
select pg_temp.expect_no_write('owner sets completed row to script_ready',
  $q$update public.video_requests set status = 'script_ready' where id = 'aaaa3232-0000-4000-8000-000000000001'$q$);
select pg_temp.expect_no_write('owner changes the prompt (topic)',
  $q$update public.video_requests set topic = 'tema cambiado' where id = 'aaaa3232-0000-4000-8000-000000000001'$q$);
select pg_temp.expect_no_write('owner changes the script (script_json)',
  $q$update public.video_requests set script_json = '{"title":"cambiado","segments":[]}'::jsonb where id = 'aaaa3232-0000-4000-8000-000000000001'$q$);
select pg_temp.expect_no_write('owner raises render_attempts',
  $q$update public.video_requests set render_attempts = 99 where id = 'aaaa3232-0000-4000-8000-000000000001'$q$);
reset role;

do $$
declare st text; tp text; sj jsonb; ra int; vp text;
begin
  select status, topic, script_json, render_attempts, video_path into st, tp, sj, ra, vp
    from public.video_requests where id = 'aaaa3232-0000-4000-8000-000000000001';
  if st <> 'completed' or tp <> 'tema original' or sj->>'title' <> 'original' or ra <> 1
     or vp <> 'aaaa3232-0000-4000-8000-000000000001/attempt-1/final.mp4' then
    raise exception 'FALLO B3.2: completed row changed (% / % / % / % / %)', st, tp, sj, ra, vp;
  end if;
  raise notice 'ok: completed row unchanged after every owner write attempt';
end $$;

-- ============================== 2. avatars: no client writes ==============================
set role service_role;
-- The app's legitimate insert (exact column set of src/app/dashboard/new/actions.ts), now via service_role.
insert into public.avatars (id, user_id, name, provider, provider_avatar_id, provider_job_id, source_photo_path, status,
                            consent_given, consent_given_at, consent_policy_version)
values ('cccc3232-0000-4000-8000-000000000001', '41414141-4141-4141-8141-414141414141', 'Avatar de A', 'heygen', 'prov-av-1', null,
        '41414141-4141-4141-8141-414141414141/photo-1.jpeg', 'ready', true, now(), 'v1')
returning id, status;
insert into public.avatars (id, user_id, name, provider, status, consent_given)
values ('cccc3232-0000-4000-8000-000000000002', '42424242-4242-4242-8242-424242424242', 'Avatar de B', 'heygen', 'uploaded', false);
-- pipeline.ts: the worker records the provider avatar and readiness.
update public.avatars set provider_avatar_id = 'prov-av-1b', status = 'ready' where id = 'cccc3232-0000-4000-8000-000000000001';
reset role;

set role authenticated;
set request.jwt.claim.sub = '41414141-4141-4141-8141-414141414141';
select pg_temp.expect_no_write('client inserts a plain avatar for itself',
  $q$insert into public.avatars (user_id, name, provider) values ('41414141-4141-4141-8141-414141414141', 'a', 'heygen')$q$);
select pg_temp.expect_no_write('client inserts a ready avatar with provider id, photo path and consent',
  $q$insert into public.avatars (user_id, name, provider, provider_avatar_id, source_photo_path, status, consent_given, consent_given_at)
     values ('41414141-4141-4141-8141-414141414141', 'a', 'heygen', 'stolen', '42424242-4242-4242-8242-424242424242/photo.jpeg', 'ready', true, now())$q$);
select pg_temp.expect_no_write('client inserts an avatar for another user',
  $q$insert into public.avatars (user_id, name, provider) values ('42424242-4242-4242-8242-424242424242', 'a', 'heygen')$q$);
select pg_temp.expect_no_write('client inserts with a past created_at',
  $q$insert into public.avatars (user_id, name, provider, created_at) values ('41414141-4141-4141-8141-414141414141', 'a', 'heygen', now() - interval '1 year')$q$);
select pg_temp.expect_no_write('client updates its avatar status',
  $q$update public.avatars set status = 'ready' where id = 'cccc3232-0000-4000-8000-000000000001'$q$);
select pg_temp.expect_no_write('client updates its avatar photo path',
  $q$update public.avatars set source_photo_path = '42424242-4242-4242-8242-424242424242/photo.jpeg' where id = 'cccc3232-0000-4000-8000-000000000001'$q$);
select pg_temp.expect_no_write('client updates its avatar user_id',
  $q$update public.avatars set user_id = '42424242-4242-4242-8242-424242424242' where id = 'cccc3232-0000-4000-8000-000000000001'$q$);

do $$
declare own int; foreign_rows int;
begin
  select count(*) into own from public.avatars where id = 'cccc3232-0000-4000-8000-000000000001';
  select count(*) into foreign_rows from public.avatars where id = 'cccc3232-0000-4000-8000-000000000002';
  if own <> 1 then raise exception 'FALLO B3.2: owner can no longer read its own avatar'; end if;
  if foreign_rows <> 0 then raise exception 'FALLO B3.2: owner can read another user''s avatar'; end if;
  raise notice 'ok: the dashboard read (own avatars only) still works';
end $$;
reset role;

set role anon;
reset request.jwt.claim.sub;
select pg_temp.expect_no_write('anon inserts an avatar',
  $q$insert into public.avatars (user_id, name, provider) values ('41414141-4141-4141-8141-414141414141', 'a', 'heygen')$q$);
reset role;

do $$
declare st text; pa text; sp text; uid uuid; n int;
begin
  select status, provider_avatar_id, source_photo_path, user_id into st, pa, sp, uid from public.avatars where id = 'cccc3232-0000-4000-8000-000000000001';
  if st <> 'ready' or pa <> 'prov-av-1b' or sp <> '41414141-4141-4141-8141-414141414141/photo-1.jpeg' or uid <> '41414141-4141-4141-8141-414141414141' then
    raise exception 'FALLO B3.2: avatar changed by a client (% / % / % / %)', st, pa, sp, uid;
  end if;
  select count(*) into n from public.avatars where user_id in ('41414141-4141-4141-8141-414141414141', '42424242-4242-4242-8242-424242424242');
  if n <> 2 then raise exception 'FALLO B3.2: expected only the 2 service-role avatars, found %', n; end if;
  if has_table_privilege('authenticated', 'public.avatars', 'INSERT') or has_table_privilege('authenticated', 'public.avatars', 'UPDATE')
     or has_table_privilege('anon', 'public.avatars', 'INSERT') or has_column_privilege('authenticated', 'public.avatars', 'status', 'UPDATE') then
    raise exception 'FALLO B3.2: a client role still holds an avatars write privilege';
  end if;
  if not has_table_privilege('authenticated', 'public.avatars', 'SELECT') then raise exception 'FALLO B3.2: authenticated lost SELECT on avatars'; end if;
  if not has_table_privilege('service_role', 'public.avatars', 'INSERT') or not has_table_privilege('service_role', 'public.avatars', 'UPDATE') then
    raise exception 'FALLO B3.2: service_role lost a write privilege on avatars';
  end if;
  raise notice 'ok: avatars written only by service_role; clients keep SELECT of their own rows';
end $$;

-- Re-running both guards is a no-op.
\ir ../0031_video_request_column_guard.sql
\ir ../0032_avatar_write_guard.sql

delete from public.video_requests where user_id in ('41414141-4141-4141-8141-414141414141', '42424242-4242-4242-8242-424242424242');
delete from public.avatars where user_id in ('41414141-4141-4141-8141-414141414141', '42424242-4242-4242-8242-424242424242');
delete from auth.users where id in ('41414141-4141-4141-8141-414141414141', '42424242-4242-4242-8242-424242424242');
select 'B3.2 COMPLETED-ROW AND AVATAR GUARD: ALL CHECKS PASSED' as result;
