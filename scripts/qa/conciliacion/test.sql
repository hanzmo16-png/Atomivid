-- USD 0. Assertions for docs/ops/conciliacion/pi_reconcile_open_operation.sql on a DISPOSABLE database (synthetic rows only).
-- Every check prints PASS/FAIL; nothing here connects anywhere else.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
create schema if not exists qa;
create or replace function qa.err(sql text) returns text language plpgsql as $$
begin execute sql; return '(no error)'; exception when others then return sqlerrm; end $$;
create or replace function qa.check(name text, ok boolean, detail text default '') returns text language sql as $$
  select case when ok then 'PASS ' || name else 'FAIL ' || name || coalesce(' :: ' || detail, '') end $$;
create or replace function qa.spend(p text, s timestamptz) returns numeric language sql as $$ select public.pi_supply_spend(p, s) $$;
create or replace function qa.upd(k text) returns timestamptz language sql as $$ select updated_at from public.pi_paid_operations where idempotency_key = k $$;
create or replace function qa.st(k text) returns text language sql as $$ select status from public.pi_paid_operations where idempotency_key = k $$;
create or replace function qa.rec(d text, k text, outcome text, ev text, amt numeric default null, over boolean default false) returns jsonb language sql as $$
  select public.pi_reconcile_open_operation(d, k, qa.st(k), qa.upd(k), outcome, ev, amt, over) $$;

-- synthetic rows (30 h old so the 24 h freshness rule lets them through; r6 is fresh)
set session_replication_role = replica;
insert into public.pi_paid_operations (idempotency_key, project_id, shot_id, provider, model, method, attempt_kind, reserved_usd, status, provider_job_id, created_at, updated_at) values
 ('qa-r1', 'qa-proj', 's1', 'openai', 'gpt-image', 'generate_image', 'initial', 0.23, 'RESERVED', null, now() - interval '30 hours', now() - interval '30 hours'),
 ('qa-r2', 'podcast-qa', 's2', 'heygen', 'avatar', 'generate_video', 'initial', 6.58, 'RESERVED', null, now() - interval '30 hours', now() - interval '30 hours'),
 ('qa-r3', 'qa-proj', 's3', 'anthropic', 'claude', 'generate_script', 'initial', 0.05, 'RECONCILIATION_REQUIRED', null, now() - interval '30 hours', now() - interval '30 hours'),
 ('qa-r4', 'qa-proj', 's4', 'openai', 'gpt-image', 'generate_image', 'initial', 0.40, 'RECONCILIATION_REQUIRED', null, now() - interval '30 hours', now() - interval '30 hours'),
 ('qa-r5', 'qa-proj', 's5', 'internal', 'none', 'resume_incomplete_visual_trial', 'initial', 0, 'SUBMITTED', null, now() - interval '30 hours', now() - interval '30 hours'),
 ('qa-r6', 'qa-proj', 's6', 'openai', 'gpt-image', 'generate_image', 'initial', 0.10, 'RESERVED', null, now() - interval '1 hour', now() - interval '1 hour'),
 ('qa-r7', 'qa-proj', 's7', 'heygen', 'avatar', 'generate_video', 'initial', 1.00, 'RESERVED', 'job-x', now() - interval '30 hours', now() - interval '30 hours'),
 ('qa-r8', 'qa-proj', 's8', 'bfl', 'flux', 'text-to-image', 'initial', 0.03, 'RECONCILIATION_REQUIRED', null, now() - interval '30 hours', now() - interval '30 hours'),
 ('qa-r9', 'qa-proj', 's9', 'anthropic', 'claude', 'generate_script', 'initial', 0.07, 'RECONCILIATION_REQUIRED', null, now() - interval '30 hours', now() - interval '30 hours'),
 ('qa-r10', 'qa-proj', 's10', 'openai', 'gpt-image', 'generate_image', 'initial', 0.11, 'RECONCILIATION_REQUIRED', null, now() - interval '30 hours', now() - interval '30 hours'),
 ('qa-r11', 'qa-proj', 's11', 'openai', 'gpt-image', 'generate_image', 'initial', 0.50, 'RESERVED', null, now() - interval '30 hours', now() - interval '30 hours');
set session_replication_role = origin;
create temp table w as select date_trunc('day', now() - interval '30 hours') as s;

-- A0: why a naive release is wrong — REFUNDED without supply_reconciled ADDS the reservation to the period's spend
begin;
create temp table naive as select qa.spend('openai', (select s from w)) as before;
update public.pi_paid_operations set status = 'REFUNDED', committed_usd = 0 where idempotency_key = 'qa-r11';
select qa.check('A0 naive RESERVED→REFUNDED (supply_reconciled=false) adds its reserved_usd to pi_supply_spend (the hazard this tool avoids)',
  qa.spend('openai', (select s from w)) - (select before from naive) = 0.50, (qa.spend('openai', (select s from w)) - (select before from naive))::text);
rollback;
select qa.check('A0 naive release rolled back', qa.st('qa-r11') = 'RESERVED');

-- A1 RESERVED → cancelled_before_submission
create temp table s1 as select qa.spend('openai', (select s from w)) v;
select qa.check('A1 RESERVED cancelled_before_submission → REFUNDED', (qa.rec('dec-0001-r1', 'qa-r1', 'cancelled_before_submission', 'never submitted (no SUBMITTED transition, no job id)')->>'status') = 'REFUNDED');
select qa.check('A1 row: committed 0, supply_reconciled, result_ref cancelled-before-submission:',
  (select committed_usd = 0 and supply_reconciled and result_ref = 'cancelled-before-submission:dec-0001-r1' from public.pi_paid_operations where idempotency_key = 'qa-r1'));
select qa.check('A1 pi_supply_spend unchanged (was not counted, still not counted)', qa.spend('openai', (select s from w)) = (select v from s1));
-- A2 idempotent replay
select qa.check('A2 replay of the same decision → replayed', (public.pi_reconcile_open_operation('dec-0001-r1', 'qa-r1', 'whatever', now(), 'cancelled_before_submission', 'x')->>'replayed')::boolean);
select qa.check('A2 replay changed nothing (one log row, row unchanged)', (select count(*) from public.pi_reconciliation_log where idempotency_key = 'qa-r1') = 1 and qa.st('qa-r1') = 'REFUNDED');
-- A3/A4 decision ids and double decisions
select qa.check('A3 a used decision_id cannot be reused for another operation', qa.err($q$select qa.rec('dec-0001-r1', 'qa-r2', 'cancelled_before_submission', 'x')$q$) like '%already used%');
select qa.check('A4 a second decision on a reconciled operation is refused',
  qa.err($q$select public.pi_reconcile_open_operation('dec-0002-r1', 'qa-r1', 'REFUNDED', qa.upd('qa-r1'), 'not_charged', 'x')$q$) like '%already reconciled%');
-- A5 RESERVED can never be charged or "not_charged"
select qa.check('A5 RESERVED cannot be charged', qa.err($q$select qa.rec('dec-0005-a', 'qa-r2', 'charged', 'invoice', 6.58)$q$) like '%never sent%');
select qa.check('A5 RESERVED cannot be assumed_charged', qa.err($q$select qa.rec('dec-0005-b', 'qa-r2', 'assumed_charged', 'none')$q$) like '%never sent%');
select qa.check('A5 RESERVED must use cancelled_before_submission', qa.err($q$select qa.rec('dec-0005-c', 'qa-r2', 'not_charged', 'x')$q$) like '%use cancelled_before_submission%');
-- A6 freshness, provider data, CAS
select qa.check('A6 row touched < 24 h is refused (may be live)', qa.err($q$select qa.rec('dec-0006-a', 'qa-r6', 'cancelled_before_submission', 'x')$q$) like '%last 24 h%');
select qa.check('A6 RESERVED with a provider job id is refused', qa.err($q$select qa.rec('dec-0006-b', 'qa-r7', 'cancelled_before_submission', 'x')$q$) like '%provider data%');
select qa.check('A6 CAS: wrong expected updated_at is refused',
  qa.err($q$select public.pi_reconcile_open_operation('dec-0006-c', 'qa-r2', 'RESERVED', now(), 'cancelled_before_submission', 'x')$q$) like '%changed since the plan%');
select qa.check('A6 CAS: wrong expected status is refused',
  qa.err($q$select public.pi_reconcile_open_operation('dec-0006-d', 'qa-r2', 'SUBMITTED', qa.upd('qa-r2'), 'cancelled_before_submission', 'x')$q$) like '%changed since the plan%');
-- A7 input validation
select qa.check('A7 evidence required', qa.err($q$select qa.rec('dec-0007-a', 'qa-r4', 'not_charged', '  ')$q$) like '%evidence required%');
select qa.check('A7 short decision id refused', qa.err($q$select qa.rec('d1', 'qa-r4', 'not_charged', 'x')$q$) like '%decision_id required%');
select qa.check('A7 unknown outcome refused', qa.err($q$select qa.rec('dec-0007-b', 'qa-r4', 'released', 'x')$q$) like '%unknown outcome%');
select qa.check('A7 negative amount refused', qa.err($q$select qa.rec('dec-0007-c', 'qa-r4', 'charged', 'inv', -1)$q$) like '%>= 0%');
select qa.check('A7 not_charged with an amount refused', qa.err($q$select qa.rec('dec-0007-d', 'qa-r4', 'not_charged', 'x', 0.4)$q$) like '%no amount%');
select qa.check('A7 refusals wrote nothing (r4 still RECONCILIATION_REQUIRED, no log rows)',
  qa.st('qa-r4') = 'RECONCILIATION_REQUIRED' and not exists (select 1 from public.pi_reconciliation_log where idempotency_key = 'qa-r4'));
-- A8 RECONCILIATION_REQUIRED assumed_charged: counted once, no double count
create temp table s8 as select qa.spend('anthropic', (select s from w)) per, qa.spend('anthropic', now() + interval '1 hour') later;
select qa.check('A8 RR assumed_charged → COMMITTED at the reserved amount', (qa.rec('dec-0008-r3', 'qa-r3', 'assumed_charged', 'Anthropic console: no request id; cannot prove not charged')->>'amountUsd')::numeric = 0.05 and qa.st('qa-r3') = 'COMMITTED');
select qa.check('A8 same-period spend unchanged (RR counted always → COMMITTED counted in its period: no double count)', qa.spend('anthropic', (select s from w)) = (select per from s8));
select qa.check('A8 a later period no longer carries it (RR counted forever before)', (select later from s8) - qa.spend('anthropic', now() + interval '1 hour') = 0.05);
-- A9 not_charged releases a RR from every cap
create temp table s9 as select qa.spend('openai', (select s from w)) v;
select qa.check('A9 RR not_charged → REFUNDED', (qa.rec('dec-0009-r4', 'qa-r4', 'not_charged', 'OpenAI usage export: no image request at that time')->>'status') = 'REFUNDED');
select qa.check('A9 row: supply_reconciled, committed 0', (select supply_reconciled and committed_usd = 0 from public.pi_paid_operations where idempotency_key = 'qa-r4'));
select qa.check('A9 spend decreases by exactly the reservation', (select v from s9) - qa.spend('openai', (select s from w)) = 0.40);
-- A10 charged above the reservation needs an explicit flag
select qa.check('A10 charged above reservation refused without flag', qa.err($q$select qa.rec('dec-0010-a', 'qa-r8', 'charged', 'BFL task t1', 0.05)$q$) like '%exceeds the reservation%');
select qa.check('A10 charged above reservation with flag → COMMITTED', (qa.rec('dec-0010-b', 'qa-r8', 'charged', 'BFL task t1', 0.05, true)->>'amountUsd')::numeric = 0.05);
select qa.check('A10 row: committed_usd = provider amount 0.05', (select committed_usd = 0.05 and status = 'COMMITTED' from public.pi_paid_operations where idempotency_key = 'qa-r8'));
-- A11 SUBMITTED internal (USD 0)
select qa.check('A11 SUBMITTED internal not_charged → REFUNDED', (qa.rec('dec-0011-r5', 'qa-r5', 'not_charged', 'internal provider: no external call, reserved 0')->>'status') = 'REFUNDED');
-- A12 final rows stay final; forward-only trigger still enforced
select qa.check('A12 a COMMITTED row cannot be reconciled again', qa.err($q$select public.pi_reconcile_open_operation('dec-0012-a', 'qa-r3', 'COMMITTED', qa.upd('qa-r3'), 'not_charged', 'x')$q$) like '%already reconciled%');
select qa.check('A12 forward-only trigger still forbids moving a final row', qa.err($q$update public.pi_paid_operations set status = 'RESERVED' where idempotency_key = 'qa-r3'$q$) like '%final%');
-- A13 audit log
select qa.check('A13 log is append-only (update)', qa.err($q$update public.pi_reconciliation_log set evidence = 'tampered'$q$) like '%append-only%');
select qa.check('A13 log is append-only (delete)', qa.err($q$delete from public.pi_reconciliation_log$q$) like '%append-only%');
select qa.check('A13 log is append-only (truncate)', qa.err($q$truncate public.pi_reconciliation_log$q$) like '%append-only%');
select qa.check('A13 each log row keeps before/after, evidence and actor',
  (select bool_and(before_row->>'status' in ('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED') and after_row->>'status' in ('COMMITTED','REFUNDED') and length(evidence) > 0 and actor <> '') from public.pi_reconciliation_log));
select qa.check('A13 one log row per reconciled operation, amounts match the ledger',
  (select count(*) = count(distinct idempotency_key) and bool_and(l.amount_usd = coalesce(p.committed_usd, 0)) from public.pi_reconciliation_log l join public.pi_paid_operations p using (idempotency_key)));
-- A14 privileges
select qa.check('A14 anon/authenticated/service_role cannot EXECUTE the tool',
  not has_function_privilege('anon', 'public.pi_reconcile_open_operation(text,text,text,timestamptz,text,text,numeric,boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.pi_reconcile_open_operation(text,text,text,timestamptz,text,text,numeric,boolean)', 'execute')
  and not has_function_privilege('service_role', 'public.pi_reconcile_open_operation(text,text,text,timestamptz,text,text,numeric,boolean)', 'execute'));
select qa.check('A14 clients cannot read or write the log',
  not has_table_privilege('anon', 'public.pi_reconciliation_log', 'select') and not has_table_privilege('authenticated', 'public.pi_reconciliation_log', 'insert')
  and not has_table_privilege('service_role', 'public.pi_reconciliation_log', 'insert'));
