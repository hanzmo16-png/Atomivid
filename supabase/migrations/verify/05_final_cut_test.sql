-- Verifies 0027 on a local Postgres (run after 03/04). Every expectation raises on failure.
\set ON_ERROR_STOP on
create or replace function pg_temp.expect_fail(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'OK: % rejected (%)', label, sqlerrm; return; end;
  raise exception 'SECURITY/INTEGRITY FAILURE: % was accepted', label;
end $$;

insert into public.fc_inspections (report_id, master_id, production_id, inspection_version, policy_version, mode, source_kind, source_ref, input_sha256, verdict, technical, editorial, opening, counts)
values ('fcr_1', 'm1', 'p1', 'final-cut-inspection/1', 'final-cut-policy/1', 'INSPECT_ONLY', 'edit_timeline', 'sb.json', repeat('a', 64), 'REPAIR_REQUIRED', '{}', '{}', '{}', '{}');
insert into public.fc_issues (report_id, issue_id, category, rule, severity, confidence, description, recommended_action, repair_class)
values ('fcr_1', 'fci_1', 'rhythm', 'R_STATIC_RUN', 'major', 0.95, 'x', 'y', 'SMART_REPAIR');
select pg_temp.expect_fail($$update public.fc_inspections set verdict = 'PASS' where report_id = 'fcr_1'$$, 'editing an inspection');
select pg_temp.expect_fail($$delete from public.fc_issues where issue_id = 'fci_1'$$, 'deleting an issue');
select pg_temp.expect_fail($$insert into public.fc_inspections (report_id, master_id, production_id, inspection_version, policy_version, mode, source_kind, source_ref, input_sha256, verdict, technical, editorial, opening, counts) values ('fcr_2','m1','p1','v','v','REPAIR','media','x','short','PASS','{}','{}','{}','{}')$$, 'an inspection without a full input hash');
-- A SMART_REPAIR cannot be recorded as EXECUTED without a person and a reservation.
select pg_temp.expect_fail($$insert into public.fc_repairs (repair_id, master_id, issue_id, rule, kind, proposed_repair, status) values ('rp_x','m1','fci_1','R_STATIC_RUN','SMART_REPAIR','ANIMATE_STILL','EXECUTED')$$, 'an executed paid repair without authorization');
insert into public.fc_repairs (repair_id, master_id, issue_id, rule, kind, proposed_repair, status, authorized_by, reservation_id) values ('rp_ok','m1','fci_1','R_STATIC_RUN','SMART_REPAIR','ANIMATE_STILL','EXECUTED','producer','res_1');
insert into public.fc_repairs (repair_id, master_id, rule, kind, proposed_repair, status, before_master_id, after_master_id) values ('af_1','m1','AUTO_FIX','AUTO_FIX','AUTO_FIX','EXECUTED','m1','m1-fix1');
-- Leaving human review records the decision.
select pg_temp.expect_fail($$insert into public.fc_qa_decisions (production_id, master_id, from_state, to_state, decided_at) values ('p1','m1','HUMAN_REVIEW_REQUIRED','EDITORIAL_QA_PASS',now())$$, 'a human-review exit without a recorded decision');
insert into public.fc_qa_decisions (production_id, master_id, from_state, to_state, human_override, decided_at) values ('p1','m1','HUMAN_REVIEW_REQUIRED','EDITORIAL_QA_PASS','{"by":"producer","decision":"accept","reason":"stylistic"}',now());
select pg_temp.expect_fail($$delete from public.fc_qa_decisions$$, 'deleting a QA decision');
insert into public.fc_master_metrics (production_id, master_id, report_id, metrics) values ('p1', 'm1', 'fcr_1', '{"opening":{"shotCount":7}}');

grant select on public.fc_inspections, public.fc_issues, public.fc_repairs, public.fc_qa_decisions, public.fc_master_metrics to authenticated;
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$
begin
  if (select count(*) from public.fc_inspections) + (select count(*) from public.fc_issues) + (select count(*) from public.fc_repairs) + (select count(*) from public.fc_qa_decisions) + (select count(*) from public.fc_master_metrics) <> 0 then raise exception 'final cut records readable by a client'; end if;
  raise notice 'OK: final cut records are service-role only';
end $$;
reset role;
select 'ALL FINAL CUT MIGRATION CHECKS PASSED' as result;
