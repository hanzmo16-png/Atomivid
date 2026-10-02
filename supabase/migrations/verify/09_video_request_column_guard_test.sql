-- PI V2 Fase B3.1 (RB-06): clients cannot write protected video_requests columns (migration 0031).
-- Run after 00_stub + every migration (see README). The setup emulates Supabase's default grants
-- (table-level ALL to anon/authenticated/service_role) and then re-applies 0031 on top, exactly as
-- it runs in a real project. Every expectation that fails raises 'FALLO …' and stops the script.
\set ON_ERROR_STOP on

grant select, insert, update, delete on public.video_requests to anon, authenticated, service_role;
\ir ../0031_video_request_column_guard.sql

insert into auth.users (id, email) values
  ('31313131-3131-4131-8131-313131313131', 'b31-user-a@test.local'),
  ('32323232-3232-4232-8232-323232323232', 'b31-user-b@test.local')
on conflict (id) do nothing;

-- A row of user B (written by the backend) whose object user A will try to point at.
insert into public.video_requests (id, user_id, topic, style, duration_seconds, mode, status, video_path)
values ('bbbb3131-0000-4000-8000-000000000002', '32323232-3232-4232-8232-323232323232', 'tema de B', 'Motivacional', 30, 'visual', 'completed',
        'bbbb3131-0000-4000-8000-000000000002/output/final.mp4');

-- Helper: run one statement as user A and require that the database refuses it (42501).
create or replace function pg_temp.expect_refused(label text, stmt text) returns void language plpgsql as $$
declare refused boolean := false;
begin
  begin
    execute stmt;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'FALLO B3.1: % — the database accepted it', label; end if;
  raise notice 'ok refused: %', label;
end $$;

-- ===== 1. authenticated user A tries to write protected columns: refused =====
set role authenticated;
set request.jwt.claim.sub = '31313131-3131-4131-8131-313131313131';

select pg_temp.expect_refused('insert video_path pointing at user B''s object',
  $q$insert into public.video_requests (user_id, topic, style, duration_seconds, mode, video_path)
     values ('31313131-3131-4131-8131-313131313131', 't', 's', 30, 'visual', 'bbbb3131-0000-4000-8000-000000000002/output/final.mp4')$q$);
select pg_temp.expect_refused('insert render_attempts',
  $q$insert into public.video_requests (user_id, topic, style, duration_seconds, mode, render_attempts)
     values ('31313131-3131-4131-8131-313131313131', 't', 's', 30, 'visual', -5)$q$);
select pg_temp.expect_refused('insert long_form_production_plan',
  $q$insert into public.video_requests (user_id, topic, style, duration_seconds, mode, long_form_production_plan)
     values ('31313131-3131-4131-8131-313131313131', 't', 's', 30, 'long_form', '{"version":3}'::jsonb)$q$);
select pg_temp.expect_refused('insert long_form_confirmed_at',
  $q$insert into public.video_requests (user_id, topic, style, duration_seconds, mode, long_form_confirmed_at)
     values ('31313131-3131-4131-8131-313131313131', 't', 's', 30, 'long_form', now())$q$);
select pg_temp.expect_refused('insert created_at in the past (quota)',
  $q$insert into public.video_requests (user_id, topic, style, duration_seconds, mode, created_at)
     values ('31313131-3131-4131-8131-313131313131', 't', 's', 30, 'visual', now() - interval '60 days')$q$);
select pg_temp.expect_refused('insert status completed',
  $q$insert into public.video_requests (user_id, topic, style, duration_seconds, mode, status)
     values ('31313131-3131-4131-8131-313131313131', 't', 's', 30, 'visual', 'completed')$q$);
select pg_temp.expect_refused('insert status processing',
  $q$insert into public.video_requests (user_id, topic, style, duration_seconds, mode, status)
     values ('31313131-3131-4131-8131-313131313131', 't', 's', 30, 'visual', 'processing')$q$);
select pg_temp.expect_refused('insert as user B (user_id of another user)',
  $q$insert into public.video_requests (user_id, topic, style, duration_seconds, mode)
     values ('32323232-3232-4232-8232-323232323232', 't', 's', 30, 'visual')$q$);
select pg_temp.expect_refused('update video_path',
  $q$update public.video_requests set video_path = 'bbbb3131-0000-4000-8000-000000000002/output/final.mp4'$q$);
select pg_temp.expect_refused('update render_attempts',
  $q$update public.video_requests set render_attempts = 0$q$);
select pg_temp.expect_refused('update long_form_production_plan',
  $q$update public.video_requests set long_form_production_plan = '{}'::jsonb$q$);
reset role;

set role anon;
reset request.jwt.claim.sub;
select pg_temp.expect_refused('anon insert with video_path',
  $q$insert into public.video_requests (user_id, topic, style, duration_seconds, mode, video_path)
     values ('31313131-3131-4131-8131-313131313131', 't', 's', 30, 'visual', 'x/final.mp4')$q$);
select pg_temp.expect_refused('anon insert of a plain row',
  $q$insert into public.video_requests (user_id, topic, style, duration_seconds, mode)
     values ('31313131-3131-4131-8131-313131313131', 't', 's', 30, 'visual')$q$);
reset role;

-- ===== 2. the app's legitimate inserts still work: pending and script_ready for its own user_id =====
set role authenticated;
set request.jwt.claim.sub = '31313131-3131-4131-8131-313131313131';
insert into public.video_requests (id, user_id, topic, style, duration_seconds, language, mode, status)
values ('aaaa3131-0000-4000-8000-000000000001', '31313131-3131-4131-8131-313131313131', 'tema de A', 'Motivacional', 30, 'es', 'visual', 'pending');
insert into public.video_requests (id, user_id, topic, style, duration_seconds, language, mode, status, script_json)
values ('aaaa3131-0000-4000-8000-000000000003', '31313131-3131-4131-8131-313131313131', 'documental de A', 'Documental', 120, 'es', 'visual', 'script_ready', '{"topic":"x","beats":[]}'::jsonb);
insert into public.video_requests (user_id, topic, style, duration_seconds, mode)
values ('31313131-3131-4131-8131-313131313131', 'default status', 'Motivacional', 30, 'visual');

-- Status update attempt on its own row: column is grantable, but no permissive UPDATE policy exists → 0 rows.
update public.video_requests set status = 'completed' where id = 'aaaa3131-0000-4000-8000-000000000001';
reset role;

do $$
declare n int; st text; ra int;
begin
  select count(*) into n from public.video_requests where user_id = '31313131-3131-4131-8131-313131313131';
  if n <> 3 then raise exception 'FALLO B3.1: expected 3 legitimate rows for A, found %', n; end if;
  select status, render_attempts into st, ra from public.video_requests where id = 'aaaa3131-0000-4000-8000-000000000001';
  if st <> 'pending' then raise exception 'FALLO B3.1: client update changed status to %', st; end if;
  if ra is distinct from 0 then raise exception 'FALLO B3.1: render_attempts should keep its default 0, found %', ra; end if;
  if exists (select 1 from public.video_requests where user_id = '31313131-3131-4131-8131-313131313131' and (video_path is not null or long_form_production_plan is not null or long_form_confirmed_at is not null)) then
    raise exception 'FALLO B3.1: a client row carries a protected value';
  end if;
  raise notice 'ok: A inserted pending + script_ready + default rows; protected columns stayed server-owned';
end $$;

-- ===== 3. service_role still writes protected columns when a job ends =====
set role service_role;
update public.video_requests
   set status = 'completed', render_attempts = 1,
       video_path = 'aaaa3131-0000-4000-8000-000000000001/attempt-1/final.mp4'
 where id = 'aaaa3131-0000-4000-8000-000000000001';
update public.video_requests
   set long_form_production_plan = '{"version":3}'::jsonb, long_form_confirmed_at = now()
 where id = 'aaaa3131-0000-4000-8000-000000000003';
reset role;

do $$
declare vp text; st text; ra int; cf timestamptz;
begin
  select video_path, status, render_attempts into vp, st, ra from public.video_requests where id = 'aaaa3131-0000-4000-8000-000000000001';
  if vp <> 'aaaa3131-0000-4000-8000-000000000001/attempt-1/final.mp4' or st <> 'completed' or ra <> 1 then
    raise exception 'FALLO B3.1: service_role update did not land (% / % / %)', vp, st, ra;
  end if;
  select long_form_confirmed_at into cf from public.video_requests where id = 'aaaa3131-0000-4000-8000-000000000003';
  if cf is null then raise exception 'FALLO B3.1: service_role could not confirm the plan'; end if;
  if not has_column_privilege('service_role', 'public.video_requests', 'video_path', 'UPDATE') then
    raise exception 'FALLO B3.1: service_role lost UPDATE on video_path';
  end if;
  if has_column_privilege('authenticated', 'public.video_requests', 'video_path', 'INSERT')
     or has_column_privilege('authenticated', 'public.video_requests', 'created_at', 'UPDATE')
     or has_column_privilege('anon', 'public.video_requests', 'render_attempts', 'INSERT') then
    raise exception 'FALLO B3.1: a client role still holds a protected column privilege';
  end if;
  if not has_column_privilege('authenticated', 'public.video_requests', 'script_json', 'INSERT') then
    raise exception 'FALLO B3.1: authenticated lost INSERT on a non-protected column';
  end if;
  raise notice 'ok: service_role writes video_path under ${id}/, status, attempts and the plan; client roles hold no protected privilege';
end $$;

-- Re-running 0031 is a no-op (idempotent).
\ir ../0031_video_request_column_guard.sql

-- Clean up this script's rows so other verify scripts are unaffected.
delete from public.video_requests where user_id in ('31313131-3131-4131-8131-313131313131', '32323232-3232-4232-8232-323232323232');
delete from auth.users where id in ('31313131-3131-4131-8131-313131313131', '32323232-3232-4232-8232-323232323232');
select 'B3.1 COLUMN GUARD: ALL CHECKS PASSED' as result;
