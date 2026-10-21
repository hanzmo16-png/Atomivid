-- Disposable local PostgreSQL only: psql -d <throwaway> -f supabase/migrations/verify/recraft_image_source.sql (from the repo root).
-- Applies the two Recraft migrations on a minimal stub and shows which transitions the trigger/constraints refuse.
\set ON_ERROR_STOP 1
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create table public.video_requests(id uuid primary key default gen_random_uuid(), mode text not null, long_form_confirmed_at timestamptz, status text);
create table public.pi_supply_policies(provider text primary key, unit text, evidence text, enabled boolean default false);
\i supabase/migrations/20261021090000_reel_recraft_images.sql
\i supabase/migrations/20261021160000_long_form_recraft_images.sql
\set ON_ERROR_STOP 0
-- 1 Reel insert with recraft ok
insert into video_requests(id,mode,reel_image_source,reel_recraft_style) values ('00000000-0000-0000-0000-000000000001','visual','recraft','{"styleId":null,"referencePaths":["a"]}');
-- 2 Long Form created without choice, confirmed WITH choice in one update: ok
insert into video_requests(id,mode,status) values ('00000000-0000-0000-0000-000000000002','long_form','script_ready');
update video_requests set reel_image_source='recraft', reel_recraft_style='{"styleId":"6654d01b-7c9d-4f87-9f99-80e6cb989380"}', long_form_confirmed_at=now() where id='00000000-0000-0000-0000-000000000002';
-- 3 after confirmation the source cannot change (EXPECT ERROR)
update video_requests set reel_image_source='default', reel_recraft_style=null where id='00000000-0000-0000-0000-000000000002';
-- 4 a LF choice without confirming in the same update (EXPECT ERROR)
insert into video_requests(id,mode,status) values ('00000000-0000-0000-0000-000000000003','long_form','script_ready');
update video_requests set reel_image_source='recraft', reel_recraft_style='{"styleId":null}' where id='00000000-0000-0000-0000-000000000003';
-- 5 Reel source cannot change after insert (EXPECT ERROR)
update video_requests set reel_image_source='default', reel_recraft_style=null where id='00000000-0000-0000-0000-000000000001';
-- 6 style_id once: set ok, change (EXPECT ERROR)
update video_requests set reel_recraft_style_id='style-aaaa-1111' where id='00000000-0000-0000-0000-000000000001';
update video_requests set reel_recraft_style_id='style-bbbb-2222' where id='00000000-0000-0000-0000-000000000001';
-- 7 avatar mode cannot pick recraft (EXPECT ERROR)
insert into video_requests(mode,reel_image_source,reel_recraft_style) values ('avatar','recraft','{}');
-- 8 an already-confirmed LF without choice cannot gain one later (EXPECT ERROR)
insert into video_requests(id,mode,long_form_confirmed_at) values ('00000000-0000-0000-0000-000000000004','long_form',now());
update video_requests set reel_image_source='recraft', reel_recraft_style='{}' where id='00000000-0000-0000-0000-000000000004';
-- 9 unrelated updates on confirmed rows still work
update video_requests set status='processing' where id='00000000-0000-0000-0000-000000000002';
select id, mode, reel_image_source, reel_recraft_style_id, status from video_requests order by id;
select provider, enabled from pi_supply_policies;
