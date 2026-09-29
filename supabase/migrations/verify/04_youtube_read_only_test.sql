-- Verifies 0026 on a local Postgres (run after 03). Every expectation raises on failure.
\set ON_ERROR_STOP on
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'OK: % rejected (%)', label, sqlerrm; return; end;
  raise exception 'SECURITY/INTEGRITY FAILURE: % was accepted', label;
end $$;

-- Links: a real 11-char video id, a storage PATH, one row per (project, video).
insert into public.yt_video_links (link_key, project_id, request_id, master_checksum_sha256, master_storage_path, channel_id, video_id, linked_at, linked_by, status)
values ('p1:dQw4w9WgXcQ', 'p1', null, '28c0e1b662d1b9c9299996bdc68abf9bafa40813b79caf1b5b9a2aab4229841f', 'p1/final/master.mp4', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'dQw4w9WgXcQ', now(), 'producer', 'linked');
select pg_temp.expect_fail($$insert into public.yt_video_links (link_key, project_id, master_checksum_sha256, master_storage_path, channel_id, video_id, linked_at, linked_by, status) values ('p1:x','p1','28c0e1b662d1b9c9299996bdc68abf9bafa40813b79caf1b5b9a2aab4229841f','https://x/master.mp4?token=abc','UCaaaaaaaaaaaaaaaaaaaaaa','dQw4w9WgXcQ',now(),'producer','linked')$$, 'a signed URL as master path');
select pg_temp.expect_fail($$insert into public.yt_video_links (link_key, project_id, master_checksum_sha256, master_storage_path, channel_id, video_id, linked_at, linked_by, status) values ('p1:short','p1','28c0e1b662d1b9c9299996bdc68abf9bafa40813b79caf1b5b9a2aab4229841f','p1/m.mp4','UCaaaaaaaaaaaaaaaaaaaaaa','abc',now(),'producer','linked')$$, 'an invalid video id');
-- Metrics: new API metric accepted; Studio-only metrics only from manual entry; label column exists.
insert into public.yt_metric_rows (row_key, channel_id, video_id, metric, value, dimension_label, window_start, window_end, source, collected_at) values
  ('ytm_p', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'v1', 'averagePercentageViewed', 41.2, null, '2026-09-01', '2026-09-28', 'youtube-analytics-v2', now()),
  ('ytm_t', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'v1', 'views', 7, 'YT_SEARCH', '2026-09-01', '2026-09-28', 'youtube-analytics-v2', now()),
  ('ytm_i', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'v1', 'impressions', 1200, null, '2026-09-01', '2026-09-28', 'manual_entry', now());
select pg_temp.expect_fail($$insert into public.yt_metric_rows (row_key, channel_id, video_id, metric, value, window_start, window_end, source, collected_at) values ('ytm_j','UCaaaaaaaaaaaaaaaaaaaaaa','v1','impressions',5,'2026-09-01','2026-09-28','youtube-analytics-v2',now())$$, 'impressions attributed to the API');
select pg_temp.expect_fail($$insert into public.yt_metric_rows (row_key, channel_id, video_id, metric, value, window_start, window_end, source, collected_at) values ('ytm_k','UCaaaaaaaaaaaaaaaaaaaaaa','v1','views',5,'2026-09-01','2026-09-28','manual_entry',now())$$, 'an API metric entered by hand');
insert into public.yt_channel_snapshots (snapshot_key, channel_id, collected_at, subscribers, total_views, video_count) values ('ytc_1', 'UCaaaaaaaaaaaaaaaaaaaaaa', now(), 12, 340, 2);
insert into public.yt_pending_connections (state, code_verifier, owner_user_id, connection_id) values ('st1', 'ver', '33333333-3333-3333-3333-333333333333', 'conn-pending');

grant select on public.yt_video_links, public.yt_channel_snapshots, public.yt_pending_connections to authenticated;
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
do $$
begin
  if (select count(*) from public.yt_video_links) <> 0 then raise exception 'owner B sees owner A links'; end if;
  if (select count(*) from public.yt_channel_snapshots) <> 0 then raise exception 'owner B sees owner A snapshots'; end if;
  if (select count(*) from public.yt_pending_connections) <> 0 then raise exception 'pending OAuth state readable by a client'; end if;
  raise notice 'OK: links and snapshots isolated per owner; pending OAuth state hidden';
end $$;
reset role;
select 'ALL YOUTUBE READ-ONLY MIGRATION CHECKS PASSED' as result;
