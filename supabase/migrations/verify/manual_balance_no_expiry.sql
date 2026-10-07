-- Execute inside BEGIN/ROLLBACK after migration. Fictional provider only;
-- no HTTP, real requests, existing policy changes, recharge or payment.
insert into public.pi_provider_accounts(provider,production_account_label,plan,secret_reference_name,status,balance_source)
values ('manual-balance-fixture','rollback-only simulation','fixture','SUPPLY_TEST_KEY','unknown','none');
insert into public.pi_supply_policies(provider,enabled,unit,baseline,unit_cost_usd,daily_forecast,daily_cap_usd,monthly_cap_usd,max_concurrent,max_daily_calls,evidence)
values ('manual-balance-fixture',true,'usd',100,1,0,20,150,5,100,'ROLLBACK ONLY');
insert into public.pi_capacity_snapshots(provider,unit,available,health,reliability,status,checked_at)
values('manual-balance-fixture','usd',100,'OK','manual_entry','GREEN',clock_timestamp()-interval '120 days');
insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,committed_usd,status,created_at,updated_at)
values
 ('manual-before','manual-fixture','before','manual-balance-fixture','fixture','simulation','initial',5,5,'COMMITTED',clock_timestamp()-interval '121 days',clock_timestamp()-interval '121 days'),
 ('manual-old-month','manual-fixture','old-month','manual-balance-fixture','fixture','simulation','initial',10,10,'COMMITTED',clock_timestamp()-interval '60 days',clock_timestamp()-interval '60 days'),
 ('manual-uncertain','manual-fixture','uncertain','manual-balance-fixture','fixture','simulation','initial',3,null,'RECONCILIATION_REQUIRED',clock_timestamp()-interval '121 days',clock_timestamp()-interval '121 days'),
 ('manual-actual','manual-fixture','actual','manual-balance-fixture','fixture','simulation','initial',5,2,'COMMITTED',clock_timestamp()-interval '40 days',clock_timestamp()-interval '40 days'),
 ('manual-call','manual-fixture-call','new','manual-balance-fixture','fixture','simulation','initial',0.1,null,'RESERVED',clock_timestamp(),clock_timestamp()),
 ('manual-denied','manual-fixture-denied','new','manual-balance-fixture','fixture','simulation','initial',0.1,null,'RESERVED',clock_timestamp(),clock_timestamp());
do $$
declare s jsonb; r jsonb; original_time timestamptz;
begin
 select checked_at into original_time from public.pi_capacity_snapshots where provider='manual-balance-fixture';
 s:=public.pi_supply_state('manual-balance-fixture');
 assert s->>'level'='GREEN','old manual observation expired';
 assert (s->>'free')::numeric=85,'past-month consumption or uncertain charges disappeared';
 assert (s->>'held')::numeric=15,'wrong debit: committed actuals plus uncertain charges';
 assert (s->>'checkedAt')::timestamptz=original_time,'observation timestamp was refreshed';
 insert into public.pi_supply_job_reservations(id,project_id,render_attempt,provider,reserved_units,reserved_usd)
 values ('manual-envelope','manual-envelope-project',1,'manual-balance-fixture',7,7);
 s:=public.pi_supply_state('manual-balance-fixture');
 assert (s->>'free')::numeric=78,'open envelope not deducted';
 r:=public.pi_submit_with_supply('manual-call',0.1);
 assert (r->>'submitted')::boolean,'valid manual-funded call blocked';
 s:=public.pi_supply_state('manual-balance-fixture');
 assert (s->>'free')::numeric=77.9,'submission did not debit available supply';
 r:=public.pi_submit_with_supply('manual-call',0.1);
 assert r->>'reason'='already_claimed','same operation submitted twice';
 update public.pi_supply_policies set daily_cap_usd=7.15 where provider='manual-balance-fixture';
 r:=public.pi_submit_with_supply('manual-denied',0.1);
 assert r->>'reason'='provider funded spend ceiling','daily cap bypassed';
 update public.pi_supply_policies set daily_cap_usd=20,monthly_cap_usd=7.15 where provider='manual-balance-fixture';
 r:=public.pi_submit_with_supply('manual-denied',0.1);
 assert r->>'reason'='provider funded spend ceiling','monthly cap bypassed';
 assert (select status from public.pi_paid_operations where idempotency_key='manual-denied')='RESERVED','denied call changed status';
 update public.pi_capacity_snapshots set available=0 where provider='manual-balance-fixture';
 assert public.pi_supply_state('manual-balance-fixture')->>'level'='RED','exhausted manual balance allowed';
 update public.pi_capacity_snapshots set available=100,health='DOWN' where provider='manual-balance-fixture';
 assert public.pi_supply_state('manual-balance-fixture')->>'level'='RED','down provider allowed';
 update public.pi_capacity_snapshots set health='OK',reliability='provider_api' where provider='manual-balance-fixture';
 assert public.pi_supply_state('manual-balance-fixture')->>'level'='UNKNOWN','old API observation allowed';
 assert not has_function_privilege('authenticated','public.pi_supply_balance_is_fresh(text,timestamptz,timestamptz)','EXECUTE');
end $$;
select 'PASS: persistent manual balance; cross-month debit; actual cost; uncertain charges; envelopes; submission; idempotency; daily/monthly caps; exhaustion; health; API expiry; permissions' as result;
