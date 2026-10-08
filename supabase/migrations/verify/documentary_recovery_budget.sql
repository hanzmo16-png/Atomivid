-- Recovery budget (20261008120000). Run inside BEGIN/ROLLBACK. Fictional owner, fixture provider, zero provider calls.
-- Every "submitted" below only flips a ledger row; nothing reaches any provider.
insert into auth.users(id,email) values ('11111111-1111-4111-8111-111111111111','owner@fixture.invalid'),('22222222-2222-4222-8222-222222222222','other@fixture.invalid');
insert into public.pi_provider_accounts(provider,production_account_label,plan,secret_reference_name,status,balance_source)
values ('budget-fixture','rollback-only simulation','fixture','SUPPLY_TEST_KEY','unknown','none');
insert into public.pi_supply_policies(provider,enabled,unit,baseline,unit_cost_usd,daily_forecast,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls,evidence)
values ('budget-fixture',true,'usd',1000,1,0,1000,1000,50,1000,'ROLLBACK ONLY fixture evidence');
update public.pi_supply_policies set enabled=true,daily_cap_usd=100000,monthly_cap_usd=100000,evidence='ROLLBACK ONLY fixture ceiling' where provider='__global__';
insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at) values('budget-fixture','usd',1000,'OK','provider_api','GREEN',clock_timestamp());
insert into public.documentary_script_jobs(id,user_id,input_hash,topic,status,stage)
values ('03738404-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','h1','Fixture bigfoot','failed','Revisando el guion'),
       ('03738404-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','h2','Fixture two','failed','Revisando el guion'),
       ('03738404-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','h3','Fixture running','running','Revisando el guion');
-- The five already-paid operations of the job (baseline): they never consume the recovery budget.
insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,committed_usd,status,result_ref)
select 'paid-'||n,'documentary:11111111-1111-4111-8111-111111111111:bigfoot','script:documentary:p'||n,'budget-fixture','fixture','generate_script','initial',0.30,(array[0.0623,0.1459,0.0648,0.0585,0.0625])[n],'COMMITTED','ref-'||n
from generate_series(1,5)n;

do $$
declare r jsonb; u jsonb; P constant text := 'documentary:11111111-1111-4111-8111-111111111111:bigfoot';
begin
 -- Opening: bound to the job and its owner; baseline = the five paid operations.
 r := public.pi_open_recovery_budget('03738404-0000-4000-8000-000000000001','documentary:22222222-2222-4222-8222-222222222222:bigfoot',2.10,'fixture authorization');
 assert r->>'reason' = 'project does not belong to the job owner', 'project of another owner accepted';
 r := public.pi_open_recovery_budget('03738404-0000-4000-8000-000000000003','documentary:11111111-1111-4111-8111-111111111111:running',2.10,'fixture authorization');
 assert r->>'reason' = 'job is not failed', 'budget opened for a running job';
 r := public.pi_open_recovery_budget('03738404-0000-4000-8000-000000000001',P,2.10,'fixture authorization');
 assert (r->>'opened')::boolean and (r->>'baselineOperations')::int = 5, 'open with five baseline operations';
 u := public.pi_recovery_budget_usage(P);
 assert (u->>'committedUsd')::numeric = 0 and (u->>'remainingUsd')::numeric = 2.10, 'baseline must not consume the budget';

 -- No reset, no raise: re-opening returns the same budget; direct changes are refused.
 r := public.pi_open_recovery_budget('03738404-0000-4000-8000-000000000001',P,99,'raise attempt');
 assert not (r->>'opened')::boolean and r->>'reason' = 'already_open' and (r->>'capUsd')::numeric = 2.10, 'budget reset or raised';
 begin update public.pi_recovery_budgets set cap_usd = 5 where project_id = P; raise exception 'cap raised';
 exception when raise_exception then if sqlerrm = 'cap raised' then raise; end if; end;
 begin update public.pi_recovery_budgets set baseline_keys = '{}' where project_id = P; raise exception 'baseline rewritten';
 exception when raise_exception then if sqlerrm = 'baseline rewritten' then raise; end if; end;
 begin delete from public.pi_recovery_budgets where project_id = P; raise exception 'budget deleted';
 exception when raise_exception then if sqlerrm = 'budget deleted' then raise; end if; end;

 -- Exact numeric: 0.7 + 0.7 + 0.7 = 2.10 is admitted (JS doubles would say 2.0999999999999996).
 insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status)
 values ('n1',P,'script:documentary:n1','budget-fixture','fixture','generate_script','initial',0.7,'RESERVED'),
        ('n2',P,'script:documentary:n2','budget-fixture','fixture','generate_script','initial',0.7,'RESERVED'),
        ('n3',P,'script:documentary:n3','budget-fixture','fixture','generate_script','initial',0.7,'RESERVED'),
        ('n4',P,'script:documentary:n4','budget-fixture','fixture','generate_script','initial',0.0001,'RESERVED');
 r := public.pi_submit_with_supply('n1',0.7); assert (r->>'submitted')::boolean, 'n1';
 -- n1 completes at a lower actual cost: committed cost counts, not its reservation.
 update public.pi_paid_operations set status='COMMITTED', committed_usd=0.7, result_ref='ref-n1' where idempotency_key='n1';
 r := public.pi_submit_with_supply('n2',0.7); assert (r->>'submitted')::boolean, 'n2';
 r := public.pi_submit_with_supply('n3',0.7); assert (r->>'submitted')::boolean, 'exactly at the 2.10 limit must be admitted';
 u := public.pi_recovery_budget_usage(P);
 assert (u->>'committedUsd')::numeric = 0.7 and (u->>'pendingUsd')::numeric = 1.4 and (u->>'remainingUsd')::numeric = 0, 'committed + pending accounting';

 -- One ledger unit (0.0001) over: refused before the provider; the row stays RESERVED.
 r := public.pi_submit_with_supply('n4',0.0001);
 assert r->>'reason' = 'recovery budget exceeded' and (r->>'capUsd')::numeric = 2.10, 'over-limit reservation admitted';
 assert (select status from public.pi_paid_operations where idempotency_key='n4') = 'RESERVED', 'refused op left RESERVED';

 -- Reusing a COMMITTED result is not a new admission and is not counted twice.
 r := public.pi_submit_with_supply('n1',0.7); assert r->>'reason' = 'already_claimed', 'committed op re-admitted';
 r := public.pi_submit_with_supply('paid-1',0.3); assert r->>'reason' = 'already_claimed', 'baseline op re-admitted';
 assert (public.pi_recovery_budget_usage(P)->>'committedUsd')::numeric = 0.7, 'double counted';

 -- Uncertain spend keeps counting; only evidence (REFUNDED / settled COMMITTED) releases it.
 update public.pi_paid_operations set status='RECONCILIATION_REQUIRED' where idempotency_key='n2';
 r := public.pi_submit_with_supply('n4',0.0001); assert r->>'reason' = 'recovery budget exceeded', 'uncertain spend released';
 update public.pi_paid_operations set status='PROVIDER_JOB_RECORDED' where idempotency_key='n3';
 r := public.pi_submit_with_supply('n4',0.0001); assert r->>'reason' = 'recovery budget exceeded', 'recorded job released';
 update public.pi_paid_operations set status='REFUNDED', committed_usd=0 where idempotency_key='n2';
 r := public.pi_submit_with_supply('n4',0.0001); assert (r->>'submitted')::boolean, 'refunded reservation must free room';

 -- Retries / restarts do not reset it: a job retry changes the job row, never the budget.
 update public.documentary_script_jobs set status='queued', stage='En cola', run_token=null where id='03738404-0000-4000-8000-000000000001';
 update public.documentary_script_jobs set status='failed' where id='03738404-0000-4000-8000-000000000001';
 r := public.pi_open_recovery_budget('03738404-0000-4000-8000-000000000001',P,2.10,'retry');
 assert r->>'reason' = 'already_open' and (r->>'capUsd')::numeric = 2.10, 'retry reset the budget';
 assert (public.pi_recovery_budget_usage(P)->>'remainingUsd')::numeric = 0.6999, 'usage persisted across retry';

 -- Closing is one-way and stops admissions.
 insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status)
 values ('n5',P,'script:documentary:n5','budget-fixture','fixture','generate_script','initial',0.01,'RESERVED');
 update public.pi_recovery_budgets set status='CLOSED', closed_at=clock_timestamp() where project_id=P;
 r := public.pi_submit_with_supply('n5',0.01); assert r->>'reason' = 'recovery budget closed', 'closed budget admitted';
 begin update public.pi_recovery_budgets set status='ACTIVE' where project_id=P; raise exception 'reopened';
 exception when raise_exception then if sqlerrm = 'reopened' then raise; end if; end;

 -- A project without a budget is unchanged (the original core decides).
 insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status)
 values ('free-1','documentary:11111111-1111-4111-8111-111111111111:other','s','budget-fixture','fixture','generate_script','initial',50,'RESERVED');
 r := public.pi_submit_with_supply('free-1',50); assert (r->>'submitted')::boolean, 'unbudgeted project changed behaviour';

 -- Opening refuses a project with uncertain operations (reconcile first).
 insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status)
 values ('unc-1','documentary:11111111-1111-4111-8111-111111111111:two','s','budget-fixture','fixture','generate_script','initial',0.1,'SUBMITTED');
 r := public.pi_open_recovery_budget('03738404-0000-4000-8000-000000000002','documentary:11111111-1111-4111-8111-111111111111:two',2.10,'x');
 assert r->>'reason' = 'uncertain operations must be reconciled first', 'budget opened over uncertain spend';

 -- Only the service role can admit; the core is no longer directly callable by the application role.
 assert not has_function_privilege('service_role','public.pi_submit_with_supply_core(text,numeric)','execute'), 'core callable directly';
 assert has_function_privilege('service_role','public.pi_submit_with_supply(text,numeric)','execute'), 'wrapper not callable';
 assert not has_function_privilege('service_role','public.pi_open_recovery_budget(uuid,text,numeric,text)','execute'), 'open callable without explicit authorization';
end $$;
select 'PASS: baseline excluded; exact 2.10 admitted, +0.0001 refused before provider; committed/pending/uncertain counted; reuse not double counted; immutable across retries; closed stops; unbudgeted unchanged' as result;
