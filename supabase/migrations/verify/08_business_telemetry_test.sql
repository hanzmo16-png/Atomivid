-- Verifies 0030 on a local Postgres (run after 07; roles anon/authenticated/service_role from 00).
-- Every expectation raises on failure. Re-applies 0030 with \i to prove idempotency.
\set ON_ERROR_STOP on
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'OK: % rejected (%)', label, sqlerrm; return; end;
  raise exception 'SECURITY/INTEGRITY FAILURE: % was accepted', label;
end $$;

-- Simulate Supabase default privileges (ALL to the API roles) then re-apply 0030: revokes must act, tables must not be recreated.
grant all on public.business_events, public.business_event_rejections, public.business_attribution_touches to anon, authenticated, service_role;
\i supabase/migrations/0030_business_telemetry_foundation.sql

do $$
declare t text; begin
  foreach t in array array['business_events', 'business_event_rejections', 'business_attribution_touches'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then raise exception '% has no RLS', t; end if;
    if (select count(*) from pg_policy where polrelid = ('public.' || t)::regclass) <> 0 then raise exception '% must have no policies', t; end if;
    if has_table_privilege('anon', 'public.' || t, 'select, insert, update, delete') then raise exception 'anon has privileges on %', t; end if;
    if has_table_privilege('authenticated', 'public.' || t, 'select, insert, update, delete') then raise exception 'authenticated has privileges on %', t; end if;
    if not has_table_privilege('service_role', 'public.' || t, 'select, insert') then raise exception 'service_role lost access to %', t; end if;
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = t || '_append_only' and not tgisinternal) then raise exception '% has no append-only trigger', t; end if;
  end loop;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'bt_append_only' and not p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public']) then raise exception 'bt_append_only must be non-definer with a pinned search_path'; end if;
  if exists (select 1 from pg_policy where polrelid in ('public.business_events'::regclass, 'public.business_event_rejections'::regclass, 'public.business_attribution_touches'::regclass) and (pg_get_expr(polqual, polrelid) = 'true' or pg_get_expr(polwithcheck, polrelid) = 'true')) then raise exception 'USING (true) policy found'; end if;
  raise notice 'OK: three telemetry tables are RLS-enabled, policy-free, client-revoked, append-only';
end $$;

-- Ledger: one fact = one row; same key twice is a primary-key conflict (the application maps it to "duplicate"); never mutable.
insert into public.business_events (event_id, event_type, schema_version, occurred_at, actor_type, user_id, production_id, request_id, source, provenance, idempotency_key, metadata, payload_hash)
values ('bev_' || repeat('a', 32), 'production_requested', 1, now() - interval '1 hour', 'user', '33333333-3333-3333-3333-333333333333', 'p1', 'p1', 'video_requests', 'derived_from_canonical_record', 'production_requested:video_requests:p1', '{"production_type":"long_form","language":"es","duration_seconds_requested":600}', repeat('b', 64));
select pg_temp.expect_fail($$insert into public.business_events (event_id, event_type, schema_version, occurred_at, actor_type, source, provenance, idempotency_key, metadata, payload_hash) values ('bev_' || repeat('a', 32), 'production_requested', 1, now(), 'user', 'x', 'observed_live', 'production_requested:video_requests:p1', '{}', repeat('b', 64))$$, 'a duplicate event_id');
select pg_temp.expect_fail($$insert into public.business_events (event_id, event_type, schema_version, occurred_at, actor_type, source, provenance, idempotency_key, metadata, payload_hash) values ('bev_' || repeat('c', 32), 'production_requested', 1, now(), 'user', 'x', 'observed_live', 'production_requested:video_requests:p1', '{}', repeat('b', 64))$$, 'a duplicate idempotency_key under a new event_id');
select pg_temp.expect_fail($$update public.business_events set metadata = '{}' where event_id = 'bev_' || repeat('a', 32)$$, 'updating a business event');
select pg_temp.expect_fail($$delete from public.business_events where event_id = 'bev_' || repeat('a', 32)$$, 'deleting a business event');
select pg_temp.expect_fail($$insert into public.business_events (event_id, event_type, schema_version, occurred_at, actor_type, source, provenance, idempotency_key, metadata, payload_hash) values ('bev_' || repeat('d', 32), 'production_requested', 1, now(), 'user', 'x', 'guessed', 'k:guessed:0001', '{}', repeat('b', 64))$$, 'an event without a valid provenance');
select pg_temp.expect_fail($$insert into public.business_events (event_id, event_type, schema_version, occurred_at, actor_type, source, provenance, idempotency_key, metadata, payload_hash) values ('bev_' || repeat('e', 32), 'production_requested', 1, now(), 'user', 'x', 'observed_live', 'k:array:0001', '[1,2]', repeat('b', 64))$$, 'metadata that is not a JSON object');
select pg_temp.expect_fail($$insert into public.business_events (event_id, event_type, schema_version, occurred_at, actor_type, source, provenance, idempotency_key, metadata, payload_hash) values ('bev_' || repeat('f', 32), 'production_requested', 1, now(), 'robot', 'x', 'observed_live', 'k:actor:0001', '{}', repeat('b', 64))$$, 'an unknown actor_type');

-- Rejections keep only reason + key hash; append-only.
insert into public.business_event_rejections (event_type, reason, detail, idempotency_key_hash, source) values ('payment_succeeded', 'invalid_currency', 'amount.currency: required', repeat('1', 32), 'stripe');
select pg_temp.expect_fail($$insert into public.business_event_rejections (event_type, reason, detail) values ('x', 'because', 'y')$$, 'a rejection with an unknown reason');
select pg_temp.expect_fail($$delete from public.business_event_rejections$$, 'deleting rejections');

-- Attribution: allowlisted columns only, path-only landing page, at least one datum, append-only.
insert into public.business_attribution_touches (touch_id, visitor_id, touched_at, landing_page, utm_source, utm_campaign, gclid, source)
values ('att_' || repeat('a', 32), 'visitor_00000001', now() - interval '2 days', '/', 'newsletter', 'launch', 'Cj0KCQ', 'web');
select pg_temp.expect_fail($$insert into public.business_attribution_touches (touch_id, visitor_id, touched_at, landing_page, source) values ('att_' || repeat('b', 32), 'visitor_00000001', now(), '/?token=abc', 'web')$$, 'a landing page carrying a query string');
select pg_temp.expect_fail($$insert into public.business_attribution_touches (touch_id, visitor_id, touched_at, source) values ('att_' || repeat('c', 32), 'visitor_00000001', now(), 'web')$$, 'a touch with no attribution datum');
select pg_temp.expect_fail($$update public.business_attribution_touches set utm_source = 'x' where touch_id = 'att_' || repeat('a', 32)$$, 'rewriting a touch');

-- Client roles: nothing readable or writable. Service role: reads and writes.
set role anon;
select pg_temp.expect_fail($$select count(*) from public.business_events$$, 'anon reading business_events');
select pg_temp.expect_fail($$insert into public.business_events (event_id, event_type, schema_version, occurred_at, actor_type, source, provenance, idempotency_key, metadata, payload_hash) values ('bev_' || repeat('9', 32), 'user_registered', 1, now(), 'user', 'x', 'observed_live', 'k:anon:0001', '{}', repeat('b', 64))$$, 'anon writing business_events');
select pg_temp.expect_fail($$select count(*) from public.business_attribution_touches$$, 'anon reading attribution');
reset role;
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select pg_temp.expect_fail($$select count(*) from public.business_events$$, 'authenticated reading global telemetry (even their own rows)');
select pg_temp.expect_fail($$insert into public.business_events (event_id, event_type, schema_version, occurred_at, actor_type, user_id, source, provenance, idempotency_key, metadata, payload_hash) values ('bev_' || repeat('8', 32), 'user_registered', 1, now(), 'user', '33333333-3333-3333-3333-333333333333', 'x', 'observed_live', 'k:auth:0001', '{}', repeat('b', 64))$$, 'authenticated writing telemetry');
select pg_temp.expect_fail($$select count(*) from public.business_event_rejections$$, 'authenticated reading rejections');
reset role;
set role service_role;
insert into public.business_events (event_id, event_type, schema_version, occurred_at, actor_type, production_id, provider, source, provenance, idempotency_key, metadata, payload_hash)
values ('bev_' || repeat('7', 32), 'provider_consumption_recorded', 1, now(), 'system', 'p1', 'runway', 'cost_engine', 'derived_from_canonical_record', 'provider_consumption_recorded:cost_engine:cost_x', '{"actual":{"amount":0.25,"currency":"USD"}}', repeat('b', 64));
do $$ begin
  if (select count(*) from public.business_events) <> 2 then raise exception 'service_role cannot read the ledger'; end if;
  raise notice 'OK: service_role reads and appends; clients denied';
end $$;
reset role;

select 'ALL BUSINESS TELEMETRY MIGRATION CHECKS PASSED' as result;
