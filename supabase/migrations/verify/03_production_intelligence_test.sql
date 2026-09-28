-- Verifies 0023-0025 on a local Postgres (see README.md). Every expectation raises on failure.
\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'owner-a@test.local'),
  ('44444444-4444-4444-4444-444444444444', 'owner-b@test.local') on conflict do nothing;

create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'OK: % rejected (%)', label, sqlerrm; return; end;
  raise exception 'SECURITY/INTEGRITY FAILURE: % was accepted', label;
end $$;

-- Paid operations: unique key, forward-only, final states immutable, no delete.
insert into public.pi_paid_operations (idempotency_key, project_id, shot_id, provider, model, method, attempt_kind, reserved_usd, status)
values ('op_1', 'p1', 'S1', 'runway', 'gen4_turbo', 'I2V_ECONOMY', 'initial', 0.25, 'RESERVED');
select pg_temp.expect_fail($$insert into public.pi_paid_operations (idempotency_key, project_id, shot_id, provider, model, method, attempt_kind, reserved_usd, status) values ('op_1','p1','S1','runway','gen4_turbo','I2V_ECONOMY','initial',0.25,'RESERVED')$$, 'duplicate idempotency key');
update public.pi_paid_operations set status = 'SUBMITTED' where idempotency_key = 'op_1';
update public.pi_paid_operations set status = 'PROVIDER_JOB_RECORDED', provider_job_id = 'job-1' where idempotency_key = 'op_1';
select pg_temp.expect_fail($$update public.pi_paid_operations set status = 'RESERVED' where idempotency_key = 'op_1'$$, 'moving a paid operation backwards');
update public.pi_paid_operations set status = 'COMMITTED', committed_usd = 0.25 where idempotency_key = 'op_1';
select pg_temp.expect_fail($$update public.pi_paid_operations set committed_usd = 0 where idempotency_key = 'op_1'$$, 'editing a committed operation');
select pg_temp.expect_fail($$delete from public.pi_paid_operations where idempotency_key = 'op_1'$$, 'deleting a paid operation');

-- Telemetry and policy history are append-only; snapshots and pins immutable; one ACTIVE policy.
insert into public.pi_telemetry_events (event_id, type, project_id, payload) values ('e1', 'attempt', 'p1', '{}');
select pg_temp.expect_fail($$update public.pi_telemetry_events set payload = '{"x":1}' where event_id = 'e1'$$, 'updating telemetry');
select pg_temp.expect_fail($$delete from public.pi_telemetry_events$$, 'deleting telemetry');
insert into public.pi_policy_versions (policy_version, status, params) values ('policy/1.0.0', 'ACTIVE', '{}');
select pg_temp.expect_fail($$insert into public.pi_policy_versions (policy_version, status, params) values ('policy/2', 'ACTIVE', '{}')$$, 'a second ACTIVE policy');
insert into public.pi_memory_snapshots (memory_snapshot_id, as_of, window_days, cells) values ('mem_1', now(), 90, '{}');
insert into public.pi_project_pins (project_id, policy_version, profile_version, contract_version, rate_card_version, memory_snapshot_id) values ('p1', 'policy/1.0.0', 'longform-16x9/1', 'shot-contract/1', 'rate-card/2026-09-28.1', 'mem_1');
select pg_temp.expect_fail($$update public.pi_project_pins set memory_snapshot_id = 'mem_1' where project_id = 'p1'$$, 'changing a project pin');
select pg_temp.expect_fail($$update public.pi_memory_snapshots set cells = '{"a":1}'$$, 'changing a memory snapshot');

-- Provider registry holds secret NAMES only; UNKNOWN capacity cannot be stored as GREEN.
insert into public.pi_provider_accounts (provider, production_account_label, plan, secret_reference_name, status, balance_source) values ('openai', 'prod', 'payg', 'OPENAI_API_KEY', 'active', 'derived_from_ledger');
select pg_temp.expect_fail($$insert into public.pi_provider_accounts (provider, production_account_label, plan, secret_reference_name, status, balance_source) values ('runway','prod','x','sk-live-1234567890abcdef','active','none')$$, 'a secret value in secret_reference_name');
select pg_temp.expect_fail($$insert into public.pi_capacity_snapshots (provider, unit, available, health, reliability, status) values ('openai','usd',null,'OK','derived_from_ledger','GREEN')$$, 'UNKNOWN balance stored as GREEN');
insert into public.pi_capacity_snapshots (provider, unit, available, health, reliability, status, derived_estimate) values ('openai', 'usd', null, 'OK', 'derived_from_ledger', 'UNKNOWN', 6.21);

-- Delivery: no signed URLs, masters kept.
insert into public.delivery_assets (project_id, asset_type, storage_path, checksum_sha256, size_bytes, duration_seconds, content_type, progressive, retention_policy)
values ('dulce-part1', 'MASTER', 'dulce-part1/final/DULCE-Part-I-master.mp4', '28c0e1b662d1b9c9299996bdc68abf9bafa40813b79caf1b5b9a2aab4229841f', 278960791, 582.7, 'video/mp4', true, 'keep');
select pg_temp.expect_fail($$insert into public.delivery_assets (project_id, asset_type, storage_path, checksum_sha256, size_bytes, content_type, retention_policy) values ('p','MASTER','x.mp4?token=eyJabc','28c0e1b662d1b9c9299996bdc68abf9bafa40813b79caf1b5b9a2aab4229841f',1,'video/mp4','keep')$$, 'a signed URL as storage path');
select pg_temp.expect_fail($$insert into public.delivery_assets (project_id, asset_type, storage_path, checksum_sha256, size_bytes, content_type, retention_policy, retention_days) values ('p','MASTER','m.mp4','28c0e1b662d1b9c9299996bdc68abf9bafa40813b79caf1b5b9a2aab4229841f',1,'video/mp4','days',30)$$, 'an expiring master');

-- YouTube: owners see only their channel; nobody on the client reads token envelopes.
insert into public.yt_channels (channel_id, owner_user_id, connection_id, language, status) values
  ('UCaaaaaaaaaaaaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'conn-a', 'en', 'connected'),
  ('UCbbbbbbbbbbbbbbbbbbbbbb', '44444444-4444-4444-4444-444444444444', 'conn-b', 'es', 'connected');
insert into public.yt_oauth_connections (connection_id, refresh_token_enc, scopes) values ('conn-a', 'v1.iv.tag.ct', array['https://www.googleapis.com/auth/youtube.readonly']);
select pg_temp.expect_fail($$insert into public.yt_oauth_connections (connection_id, refresh_token_enc, scopes) values ('conn-b','1//plaintext-refresh',array['x'])$$, 'a plaintext refresh token');
insert into public.yt_metric_rows (row_key, channel_id, video_id, metric, value, window_start, window_end, source, collected_at) values
  ('ytm_a', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'v1', 'views', 10, '2026-09-01', '2026-09-28', 'youtube-analytics-v2', now()),
  ('ytm_b', 'UCbbbbbbbbbbbbbbbbbbbbbb', 'v2', 'views', 99, '2026-09-01', '2026-09-28', 'youtube-analytics-v2', now());
select pg_temp.expect_fail($$insert into public.yt_metric_rows (row_key, channel_id, video_id, metric, value, window_start, window_end, source, collected_at) values ('ytm_c','UCaaaaaaaaaaaaaaaaaaaaaa','v1','viralityScore',1,'2026-09-01','2026-09-28','youtube-analytics-v2',now())$$, 'an invented metric');

grant select on public.yt_channels, public.yt_metric_rows, public.yt_oauth_connections, public.pi_paid_operations, public.delivery_assets to authenticated;
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$
begin
  if (select count(*) from public.yt_channels) <> 1 then raise exception 'owner A must see exactly its own channel'; end if;
  if (select count(*) from public.yt_metric_rows) <> 1 or exists (select 1 from public.yt_metric_rows where channel_id <> 'UCaaaaaaaaaaaaaaaaaaaaaa') then raise exception 'channel isolation broken'; end if;
  if (select count(*) from public.yt_oauth_connections) <> 0 then raise exception 'token envelopes readable by a client'; end if;
  if (select count(*) from public.pi_paid_operations) <> 0 then raise exception 'ledger readable by a client'; end if;
  if (select count(*) from public.delivery_assets) <> 0 then raise exception 'delivery records readable by a client'; end if;
  raise notice 'OK: RLS isolates channels and hides tokens, ledger and delivery records from clients';
end $$;
reset role;
select 'ALL PRODUCTION INTELLIGENCE MIGRATION CHECKS PASSED' as result;
