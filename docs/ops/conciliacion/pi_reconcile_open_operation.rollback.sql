-- Rollback of the reconciliation tooling. Refuses if any decision was already applied: reconciled operations are final
-- (forward-only trigger) and their audit trail must be kept.
begin;
do $$ begin
  if to_regclass('public.pi_reconciliation_log') is not null and exists (select 1 from public.pi_reconciliation_log) then
    raise exception 'ROLLBACK refused: % reconciliation decision(s) already applied; the audit log is kept', (select count(*) from public.pi_reconciliation_log);
  end if;
end $$;
drop function if exists public.pi_reconcile_open_operation(text, text, text, timestamptz, text, text, numeric, boolean);
drop table if exists public.pi_reconciliation_log;
drop function if exists public.pi_reconciliation_log_immutable();
commit;
