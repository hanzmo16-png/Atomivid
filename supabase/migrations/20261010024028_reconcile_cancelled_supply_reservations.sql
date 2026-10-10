-- A pre-submission cancellation is final, but its no-charge reconciliation bit
-- must be recordable. Otherwise the supply guard counts the cancelled reservation
-- as both money spent and a provider call. All financial/identity fields stay final.
create or replace function public.pi_paid_operation_forward_only()
returns trigger language plpgsql set search_path = '' as $$
declare
  rank_old int := array_position(array['RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED','COMMITTED','REFUNDED'], old.status);
  rank_new int := array_position(array['RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED','COMMITTED','REFUNDED'], new.status);
begin
  if old.status in ('COMMITTED','REFUNDED') then
    if old.status = 'REFUNDED'
      and old.committed_usd = 0 and old.provider_job_id is null
      and old.result_ref like 'cancelled-before-submission:%'
      and old.supply_reconciled = false and new.supply_reconciled = true
      and (to_jsonb(new) - 'supply_reconciled' - 'updated_at')
        = (to_jsonb(old) - 'supply_reconciled' - 'updated_at') then
      new.updated_at := clock_timestamp();
      return new;
    end if;
    raise exception 'paid operation % is final (%)', old.idempotency_key, old.status;
  end if;
  if rank_new < rank_old then raise exception 'paid operation % cannot move back from % to %', old.idempotency_key, old.status, new.status; end if;
  if new.idempotency_key <> old.idempotency_key or new.project_id <> old.project_id then raise exception 'identity fields are immutable'; end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;
