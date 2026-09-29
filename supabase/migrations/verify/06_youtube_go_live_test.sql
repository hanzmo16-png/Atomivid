-- Verifies 0028 on a local Postgres (run after 04). Every expectation raises on failure.
\set ON_ERROR_STOP on
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'OK: % rejected (%)', label, sqlerrm; return; end;
  raise exception 'SECURITY/INTEGRITY FAILURE: % was accepted', label;
end $$;

insert into public.yt_performance_snapshots (snapshot_key, channel_id, video_id, "window", due_at, status, collected_at, metrics, source)
values ('yts_1', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'dQw4w9WgXcQ', '7d', now(), 'COLLECTED', now(), '{"views":200}', 'youtube-analytics-v2');
select pg_temp.expect_fail($$insert into public.yt_performance_snapshots (snapshot_key, channel_id, video_id, "window", due_at, status) values ('yts_dup','UCaaaaaaaaaaaaaaaaaaaaaa','dQw4w9WgXcQ','7d',now(),'PENDING')$$, 'a duplicate (channel, video, window) snapshot');
select pg_temp.expect_fail($$update public.yt_performance_snapshots set metrics = '{"views":999}' where snapshot_key = 'yts_1'$$, 'rewriting a COLLECTED snapshot');
select pg_temp.expect_fail($$insert into public.yt_performance_snapshots (snapshot_key, channel_id, video_id, "window", due_at, status) values ('yts_2','UCaaaaaaaaaaaaaaaaaaaaaa','dQw4w9WgXcQ','24h',now(),'COLLECTED')$$, 'COLLECTED without collected_at');
insert into public.yt_performance_snapshots (snapshot_key, channel_id, video_id, "window", due_at, status) values ('yts_3', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'dQw4w9WgXcQ', '28d', now() + interval '20 days', 'NOT_DUE');
-- Launch records: prepared without a video id; manual publication needs person + time + id.
insert into public.yt_launch_records (launch_id, production_id, master_id, master_hash, master_storage_path, final_cut_status, title, language, visibility_intent, channel_id, status)
values ('p1:aaaaaaaaaaaa', 'p1', 'm1', repeat('a', 64), 'p1/final/master.mp4', 'EDITORIAL_QA_PASS', 'Ep', 'en', 'unlisted', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'PREPARED');
select pg_temp.expect_fail($$update public.yt_launch_records set status = 'PUBLISHED_MANUALLY' where launch_id = 'p1:aaaaaaaaaaaa'$$, 'published without video id / person / time');
select pg_temp.expect_fail($$insert into public.yt_launch_records (launch_id, production_id, master_id, master_hash, master_storage_path, final_cut_status, title, language, visibility_intent, channel_id, status) values ('p2:x','p2','m2',repeat('b',64),'https://x/m.mp4?token=abc','EDITORIAL_QA_PASS','Ep','en','public','UCaaaaaaaaaaaaaaaaaaaaaa','PREPARED')$$, 'a signed URL as master path');
update public.yt_launch_records set status = 'PUBLISHED_MANUALLY', youtube_video_id = 'dQw4w9WgXcQ', published_by = 'owner', published_at = now() where launch_id = 'p1:aaaaaaaaaaaa';
-- The experiment view joins links, snapshots and Final Cut metrics read-only.
select count(*) as experiment_rows from public.yt_video_experiment;

grant select on public.yt_performance_snapshots, public.yt_launch_records to authenticated;
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
do $$
begin
  if (select count(*) from public.yt_performance_snapshots) <> 0 then raise exception 'owner B sees owner A snapshots'; end if;
  if (select count(*) from public.yt_launch_records) <> 0 then raise exception 'owner B sees owner A launch records'; end if;
  raise notice 'OK: snapshots and launch records isolated per owner';
end $$;
reset role;
select 'ALL YOUTUBE GO-LIVE MIGRATION CHECKS PASSED' as result;
