-- Disposable local PostgreSQL only: psql -d <throwaway> -f supabase/migrations/verify/long_form_voice_selection.sql (repo root).
\set ON_ERROR_STOP 1
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create table public.video_requests(id uuid primary key default gen_random_uuid(), mode text not null, long_form_confirmed_at timestamptz, status text);
\i supabase/migrations/20261020200444_reel_voice_selection.sql
\i supabase/migrations/20261021180000_long_form_voice_selection.sql
\set ON_ERROR_STOP 0
-- 1 Reel insert with voice: ok
insert into video_requests(id,mode,reel_voice_id) values ('00000000-0000-0000-0000-000000000001','visual','CeFSZuaHs4SxcBxb9nCr');
-- 2 LF confirmed WITH voice in one update: ok
insert into video_requests(id,mode,status) values ('00000000-0000-0000-0000-000000000002','long_form','script_ready');
update video_requests set reel_voice_id='CeFSZuaHs4SxcBxb9nCr', long_form_confirmed_at=now() where id='00000000-0000-0000-0000-000000000002';
-- 3 after confirmation the voice cannot change (EXPECT ERROR)
update video_requests set reel_voice_id='otraVoz12345' where id='00000000-0000-0000-0000-000000000002';
-- 4 LF voice without confirming in the same update (EXPECT ERROR)
insert into video_requests(id,mode,status) values ('00000000-0000-0000-0000-000000000003','long_form','script_ready');
update video_requests set reel_voice_id='CeFSZuaHs4SxcBxb9nCr' where id='00000000-0000-0000-0000-000000000003';
-- 5 Reel voice cannot change (EXPECT ERROR)
update video_requests set reel_voice_id='otraVoz12345' where id='00000000-0000-0000-0000-000000000001';
-- 6 avatar cannot have it (EXPECT ERROR)
insert into video_requests(mode,reel_voice_id) values ('avatar','CeFSZuaHs4SxcBxb9nCr');
-- 7 already-confirmed LF cannot gain one later (EXPECT ERROR)
insert into video_requests(id,mode,long_form_confirmed_at) values ('00000000-0000-0000-0000-000000000004','long_form',now());
update video_requests set reel_voice_id='CeFSZuaHs4SxcBxb9nCr' where id='00000000-0000-0000-0000-000000000004';
-- 8 bad id format (EXPECT ERROR)
insert into video_requests(mode,reel_voice_id) values ('visual','x');
-- 9 unrelated updates on confirmed rows still work
update video_requests set status='rendering' where id='00000000-0000-0000-0000-000000000002';
select id, mode, reel_voice_id, status from video_requests order by id;
