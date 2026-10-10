-- Run only in a disposable PostgreSQL database after installing the migration
-- against this test table; never run the fixture setup in production.
create or replace function pg_temp.must_refuse(command text) returns void
language plpgsql as $$
declare refused boolean := false;
begin
  begin execute command;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception 'Expected refusal: %', command; end if;
end $$;

insert into public.pi_paid_operations values
 ('cancelled','project','heygen','REFUNDED',6.89,0,null,'cancelled-before-submission:editorial-recut',false,now()),
 ('charged','project','heygen','COMMITTED',6,6,'provider-job','asset-ref',false,now()),
 ('uncertain','project','heygen','REFUNDED',6,0,null,'rejected:upstream_error',false,now()),
 ('accepted','project','heygen','REFUNDED',6,0,'provider-job','cancelled-before-submission:invalid',false,now()),
 ('reserved','project','heygen','RESERVED',5,null,null,null,false,now());

select pg_temp.must_refuse($q$update public.pi_paid_operations set reserved_usd=0,supply_reconciled=true where idempotency_key='cancelled'$q$);
select pg_temp.must_refuse($q$update public.pi_paid_operations set project_id='other',supply_reconciled=true where idempotency_key='cancelled'$q$);
select pg_temp.must_refuse($q$update public.pi_paid_operations set status='RESERVED',supply_reconciled=true where idempotency_key='cancelled'$q$);
select pg_temp.must_refuse($q$update public.pi_paid_operations set result_ref='other',supply_reconciled=true where idempotency_key='cancelled'$q$);
select pg_temp.must_refuse($q$update public.pi_paid_operations set committed_usd=0 where idempotency_key='charged'$q$);
select pg_temp.must_refuse($q$update public.pi_paid_operations set supply_reconciled=true where idempotency_key='charged'$q$);
select pg_temp.must_refuse($q$update public.pi_paid_operations set supply_reconciled=true where idempotency_key='uncertain'$q$);
select pg_temp.must_refuse($q$update public.pi_paid_operations set supply_reconciled=true where idempotency_key='accepted'$q$);
update public.pi_paid_operations set supply_reconciled=true where idempotency_key='cancelled';
select pg_temp.must_refuse($q$update public.pi_paid_operations set supply_reconciled=false where idempotency_key='cancelled'$q$);
update public.pi_paid_operations set status='SUBMITTED' where idempotency_key='reserved';
select pg_temp.must_refuse($q$update public.pi_paid_operations set status='RESERVED' where idempotency_key='reserved'$q$);
do $$ begin
  if not exists(select 1 from public.pi_paid_operations where idempotency_key='cancelled' and status='REFUNDED' and reserved_usd=6.89 and committed_usd=0 and supply_reconciled) then
    raise exception 'Cancelled reservation reconciliation failed';
  end if;
end $$;
