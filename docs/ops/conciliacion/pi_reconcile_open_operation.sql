-- PROPOSAL (NOT APPLIED). Operator-only reconciliation of OPEN paid operations (pi_paid_operations) with provider evidence.
-- Not a migration; nothing applies this automatically. Applying it in production needs the owner's explicit authorization.
--
-- Why: 41 open operations (RESERVED / SUBMITTED / RECONCILIATION_REQUIRED) have no reviewed way to be closed. Hand-written
-- UPDATEs would bypass every rule below. The forward-only trigger already forbids moving a final row; this adds:
--   * one decision per operation, identified by decision_id (idempotent replay; a decision_id can never be reused);
--   * compare-and-set on (status, updated_at) captured in the plan: a row that changed since the plan is refused;
--   * rows touched in the last 24 h are refused (a live owner may still settle them);
--   * outcome rules by status — RESERVED never reached the provider (the engine writes SUBMITTED before any HTTP request),
--     so it can only be "cancelled_before_submission" and can never be charged; SUBMITTED/PROVIDER_JOB_RECORDED/
--     RECONCILIATION_REQUIRED left the process and may have been charged, so they need provider evidence:
--     "not_charged" (proof) → REFUNDED 0, "charged" (provider amount) → COMMITTED, "assumed_charged" (no way to prove the
--     opposite) → COMMITTED at the reserved amount (conservative);
--   * supply_reconciled = true on every REFUNDED outcome, so a released/never-charged reservation stops counting in
--     pi_supply_spend (REFUNDED with supply_reconciled = false counts its reserved_usd in the period: a naive release
--     would ADD spend);
--   * an append-only audit log with the row before/after, the evidence and the actor;
--   * EXECUTE only for the owner (postgres): neither the app (service_role) nor clients can call it.
begin;

-- Every function this install defines must either not exist yet or already belong to postgres: CREATE OR REPLACE keeps
-- the previous owner, who could later swap the body (e.g. make the append-only trigger function a no-op). The two
-- install-time helpers never survive an install, so any pre-existing one is foreign and refused outright.
do $$ declare f text; o text; begin
  foreach f in array array['public.pi_reconciliation_log_immutable()',
                           'public.pi_reconcile_open_operation(text, text, text, timestamptz, text, text, numeric, boolean)'] loop
    select pg_catalog.pg_get_userbyid(p.proowner) into o from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(f);
    if o is not null and o <> 'postgres' then
      raise exception 'tool function % exists with an incompatible owner (%); refusing to install over it', f, o using errcode = 'P0001';
    end if;
  end loop;
  if pg_catalog.to_regprocedure('public.pi_reconciliation_contract_parts(regclass)') is not null
     or pg_catalog.to_regprocedure('public.pi_reconciliation_security_problem()') is not null then
    raise exception 'install helper functions already exist (incompatible leftover); refusing to install' using errcode = 'P0001';
  end if;
end $$;

-- Catalog fingerprint of a relation's contract (names of auto-generated constraints are excluded: they embed the table name).
create or replace function public.pi_reconciliation_contract_parts(t regclass) returns setof text
language sql stable set search_path = '' as $f$
  select 'rel:' || c.relkind::text || ':partition=' || c.relispartition || ':inherits=' || (select count(*) from pg_catalog.pg_inherits i where i.inhrelid = c.oid or i.inhparent = c.oid)
    || ':rules=' || (select count(*) from pg_catalog.pg_rewrite r where r.ev_class = c.oid)
    || ':foreign_triggers=' || (select count(*) from pg_catalog.pg_trigger g where g.tgrelid = c.oid and not g.tgisinternal
         and g.tgname not in ('pi_reconciliation_log_append_only', 'pi_reconciliation_log_no_truncate'))
  from pg_catalog.pg_class c where c.oid = t
  union all
  select 'col:' || lpad(row_number() over (order by a.attnum)::text, 3, '0') || ':' || a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod)
    || ':notnull=' || a.attnotnull || ':default=' || coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '-')
    || ':collation=' || coalesce(co.collname::text, '-') || ':identity=' || a.attidentity::text || ':generated=' || a.attgenerated::text
  from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    left join pg_catalog.pg_collation co on co.oid = a.attcollation
  where a.attrelid = t and a.attnum > 0 and not a.attisdropped
  union all
  select 'con:' || k.contype::text || ':' || pg_catalog.pg_get_constraintdef(k.oid) || ':valid=' || k.convalidated || ':deferrable=' || k.condeferrable
  from pg_catalog.pg_constraint k where k.conrelid = t
$f$;
-- Security state the log must have once installed: owner postgres, RLS on, no policies, no table or column privilege
-- for anyone but the owner, and the tool's two append-only triggers present and enabled. NULL = compliant.
create or replace function public.pi_reconciliation_security_problem() returns text
language sql stable set search_path = '' as $f$
  select case
    when c.relkind <> 'r' then 'not a plain table'
    when pg_catalog.pg_get_userbyid(c.relowner) <> 'postgres' then 'owner is ' || pg_catalog.pg_get_userbyid(c.relowner) || ', expected postgres'
    when not c.relrowsecurity then 'row level security disabled'
    when exists (select 1 from pg_catalog.pg_policy p where p.polrelid = c.oid) then 'row level security policies present'
    when exists (select 1 from pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) x where x.grantee <> c.relowner)
      then 'table privileges granted to roles other than the owner'
    when exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and a.attacl is not null
                   and exists (select 1 from pg_catalog.aclexplode(a.attacl) x where x.grantee <> c.relowner))
      then 'column privileges granted to roles other than the owner'
    when (select count(*) from pg_catalog.pg_trigger g where g.tgrelid = c.oid and not g.tgisinternal and g.tgenabled = 'O'
            and g.tgname in ('pi_reconciliation_log_append_only', 'pi_reconciliation_log_no_truncate')
            and g.tgfoid = pg_catalog.to_regprocedure('public.pi_reconciliation_log_immutable()')) <> 2
      then 'append-only triggers missing, disabled or bound to another function'
  end
  from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('public.pi_reconciliation_log')
$f$;
-- One canonical definition, instantiated twice in this transaction: as a reference in a scratch schema that is dropped
-- before commit (an abort drops it too) and (only if absent) as the
-- real log. IF NOT EXISTS must never accept a different table silently, so the WHOLE contract of the existing table is
-- compared with the reference: relation kind, inheritance, columns (order, type, NOT NULL, default, identity, generated),
-- every constraint (PK, UNIQUE, FK, CHECK — definition, validity, deferrability) and no foreign triggers or rewrite rules.
-- Both sides are read from the catalog of this same server, so the comparison does not depend on the PostgreSQL version.
do $$
declare
  ddl constant text := $ddl$create table %s (
    decision_id text primary key check (length(trim(decision_id)) >= 8),
    idempotency_key text not null unique references public.pi_paid_operations (idempotency_key),
    decision_sha256 text not null check (decision_sha256 ~ '^[0-9a-f]{64}$'),
    outcome text not null check (outcome in ('cancelled_before_submission', 'not_charged', 'charged', 'assumed_charged')),
    evidence text not null check (length(trim(evidence)) > 0),
    amount_usd numeric(12,4) not null check (amount_usd >= 0),
    before_row jsonb not null,
    after_row jsonb not null,
    actor text not null default current_user,
    decided_at timestamptz not null default clock_timestamp()
  )$ddl$;
  ref_fp text;
  log_fp text;
  preexisting boolean := to_regclass('public.pi_reconciliation_log') is not null;
  bad text;
begin
  create schema pi_reconcile_contract_ref;  -- fails (and aborts the install) if the name is already taken
  execute format(ddl, 'pi_reconcile_contract_ref.pi_reconciliation_log');
  if not preexisting then execute format(ddl, 'public.pi_reconciliation_log'); end if;
  select string_agg(part, E'\n' order by part) into ref_fp from public.pi_reconciliation_contract_parts('pi_reconcile_contract_ref.pi_reconciliation_log'::regclass) part;
  select string_agg(part, E'\n' order by part) into log_fp from public.pi_reconciliation_contract_parts('public.pi_reconciliation_log'::regclass) part;
  drop schema pi_reconcile_contract_ref cascade;
  if log_fp is distinct from ref_fp then
    raise exception 'pi_reconciliation_log exists with an incompatible definition (contract % expected %); refusing to install over it',
      md5(coalesce(log_fp, '')), md5(ref_fp) using errcode = 'P0001';
  end if;
  if preexisting then
    -- A pre-existing log must already be in the exact final security state; nothing is normalized over someone else's table.
    bad := public.pi_reconciliation_security_problem();
    if bad is not null then
      raise exception 'pi_reconciliation_log exists with an incompatible definition (%); refusing to install over it', bad using errcode = 'P0001';
    end if;
  else
    -- The table this install just created is normalized: canonical owner and no grant to anyone but the owner
    -- (default privileges may have granted to other roles at creation).
    alter table public.pi_reconciliation_log owner to postgres;
    for bad in select distinct pg_catalog.quote_ident(r.rolname) from pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) x
               join pg_catalog.pg_roles r on r.oid = x.grantee
               where c.oid = 'public.pi_reconciliation_log'::regclass and x.grantee <> c.relowner loop
      execute format('revoke all on table public.pi_reconciliation_log from %s', bad);
    end loop;
    if exists (select 1 from pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) x where c.oid = 'public.pi_reconciliation_log'::regclass and x.grantee = 0) then
      revoke all on table public.pi_reconciliation_log from public;
    end if;
  end if;
end $$;
drop function public.pi_reconciliation_contract_parts(regclass);
alter table public.pi_reconciliation_log enable row level security;
revoke all on table public.pi_reconciliation_log from public, anon, authenticated, service_role;

create or replace function public.pi_reconciliation_log_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'pi_reconciliation_log is append-only (% rejected)', tg_op using errcode = 'P0001';
end $$;
alter function public.pi_reconciliation_log_immutable() owner to postgres;
drop trigger if exists pi_reconciliation_log_append_only on public.pi_reconciliation_log;
create trigger pi_reconciliation_log_append_only before update or delete on public.pi_reconciliation_log
  for each row execute function public.pi_reconciliation_log_immutable();
drop trigger if exists pi_reconciliation_log_no_truncate on public.pi_reconciliation_log;
create trigger pi_reconciliation_log_no_truncate before truncate on public.pi_reconciliation_log
  for each statement execute function public.pi_reconciliation_log_immutable();

create or replace function public.pi_reconcile_open_operation(
  p_decision_id text, p_key text, p_expected_status text, p_expected_updated_at timestamptz,
  p_outcome text, p_evidence text, p_actual_usd numeric default null, p_allow_over_reserved boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  o public.pi_paid_operations%rowtype;
  a public.pi_paid_operations%rowtype;
  prev public.pi_reconciliation_log%rowtype;
  amount numeric;
  n int;
  h text;
begin
  if p_decision_id is null or length(trim(p_decision_id)) < 8 then raise exception 'RECONCILE: decision_id required (>= 8 chars)' using errcode = 'P0001'; end if;
  -- Serialize every decision on the same operation (also covers the not-yet-logged race between two decision ids).
  perform pg_advisory_xact_lock(hashtext('pi_reconcile:' || coalesce(p_key, '')));
  -- Canonical hash of the WHOLE decision (amount normalized to the ledger scale, timestamp to UTC microseconds).
  h := encode(sha256(convert_to(jsonb_build_array(p_decision_id, p_key, p_expected_status,
         to_char(p_expected_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), p_outcome, p_evidence,
         (p_actual_usd::numeric(12,4))::text, coalesce(p_allow_over_reserved, false))::text, 'UTF8')), 'hex');
  select * into prev from public.pi_reconciliation_log where decision_id = p_decision_id;
  if found then
    if prev.decision_sha256 is distinct from h then
      raise exception 'RECONCILE: decision % replayed with different parameters (operation, preconditions, outcome, evidence, amount or override)', p_decision_id using errcode = 'P0001';
    end if;
    return jsonb_build_object('replayed', true, 'status', prev.after_row->>'status', 'amountUsd', prev.amount_usd, 'decisionSha256', h);
  end if;
  if p_evidence is null or length(trim(p_evidence)) = 0 then raise exception 'RECONCILE: provider evidence required' using errcode = 'P0001'; end if;
  select * into o from public.pi_paid_operations where idempotency_key = p_key for update;
  if not found then raise exception 'RECONCILE: operation not found' using errcode = 'P0001'; end if;
  if exists (select 1 from public.pi_reconciliation_log where idempotency_key = p_key) then
    raise exception 'RECONCILE: operation already reconciled by another decision' using errcode = 'P0001';
  end if;
  if o.status is distinct from p_expected_status or o.updated_at is distinct from p_expected_updated_at then
    raise exception 'RECONCILE: operation changed since the plan (now %, updated %)', o.status, o.updated_at using errcode = 'P0001';
  end if;
  if o.status not in ('RESERVED', 'SUBMITTED', 'PROVIDER_JOB_RECORDED', 'RECONCILIATION_REQUIRED') then
    raise exception 'RECONCILE: operation is not open (%)', o.status using errcode = 'P0001';
  end if;
  if o.updated_at > clock_timestamp() - interval '24 hours' then
    raise exception 'RECONCILE: operation touched in the last 24 h; it may still be owned by a live process' using errcode = 'P0001';
  end if;

  if p_outcome = 'cancelled_before_submission' then
    if o.status <> 'RESERVED' then raise exception 'RECONCILE: only a RESERVED row can be cancelled before submission (row is %)', o.status using errcode = 'P0001'; end if;
    if o.provider_job_id is not null or o.result_ref is not null then raise exception 'RECONCILE: RESERVED row carries provider data; reconcile it manually' using errcode = 'P0001'; end if;
    if coalesce(p_actual_usd, 0) <> 0 then raise exception 'RECONCILE: a never-submitted operation has no cost' using errcode = 'P0001'; end if;
    amount := 0;
    update public.pi_paid_operations set status = 'REFUNDED', committed_usd = 0, supply_reconciled = true,
      result_ref = 'cancelled-before-submission:' || p_decision_id
      where idempotency_key = p_key and status = o.status;
  elsif p_outcome = 'not_charged' then
    if o.status = 'RESERVED' then raise exception 'RECONCILE: a RESERVED row was never sent; use cancelled_before_submission' using errcode = 'P0001'; end if;
    if coalesce(p_actual_usd, 0) <> 0 then raise exception 'RECONCILE: not_charged has no amount' using errcode = 'P0001'; end if;
    amount := 0;
    update public.pi_paid_operations set status = 'REFUNDED', committed_usd = 0, supply_reconciled = true,
      result_ref = 'reconciled:not_charged:' || left(p_evidence, 200)
      where idempotency_key = p_key and status = o.status;
  elsif p_outcome in ('charged', 'assumed_charged') then
    if o.status = 'RESERVED' then raise exception 'RECONCILE: a RESERVED row was never sent to the provider; it cannot be charged' using errcode = 'P0001'; end if;
    if p_outcome = 'assumed_charged' then
      if p_actual_usd is not null then raise exception 'RECONCILE: assumed_charged books the reserved amount; do not pass one' using errcode = 'P0001'; end if;
      amount := o.reserved_usd;
    else
      amount := p_actual_usd;
      if amount is null or amount < 0 then raise exception 'RECONCILE: charged needs the provider amount (>= 0)' using errcode = 'P0001'; end if;
      if amount > o.reserved_usd and not coalesce(p_allow_over_reserved, false) then
        raise exception 'RECONCILE: provider amount % exceeds the reservation %; needs p_allow_over_reserved', amount, o.reserved_usd using errcode = 'P0001';
      end if;
    end if;
    update public.pi_paid_operations set status = 'COMMITTED', committed_usd = amount,
      result_ref = 'reconciled:' || p_outcome || ':' || left(p_evidence, 200)
      where idempotency_key = p_key and status = o.status;
  else
    raise exception 'RECONCILE: unknown outcome %', p_outcome using errcode = 'P0001';
  end if;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'RECONCILE: operation changed during reconciliation' using errcode = 'P0001'; end if;
  select * into a from public.pi_paid_operations where idempotency_key = p_key;
  insert into public.pi_reconciliation_log (decision_id, idempotency_key, decision_sha256, outcome, evidence, amount_usd, before_row, after_row)
    values (p_decision_id, p_key, h, p_outcome, p_evidence, amount, to_jsonb(o), to_jsonb(a));
  return jsonb_build_object('replayed', false, 'status', a.status, 'amountUsd', amount, 'decisionSha256', h);
end $$;
alter function public.pi_reconcile_open_operation(text, text, text, timestamptz, text, text, numeric, boolean) owner to postgres;
revoke all on function public.pi_reconcile_open_operation(text, text, text, timestamptz, text, text, numeric, boolean) from public, anon, authenticated, service_role;
revoke all on function public.pi_reconciliation_log_immutable() from public, anon, authenticated, service_role;
-- Final gate: the installed log and both tool functions must be in the exact security state, else the whole install is
-- rolled back. Functions: owner postgres, plpgsql, the expected SECURITY DEFINER flag, search_path pinned to '', and no
-- EXECUTE (or any privilege) for anyone but the owner.
do $$ declare bad text := public.pi_reconciliation_security_problem(); r record; begin
  if bad is not null then raise exception 'pi_reconciliation_log security state after install: %; install aborted', bad using errcode = 'P0001'; end if;
  for r in select f.sig, f.secdef, p.oid, p.proowner, p.prosecdef, p.proconfig, l.lanname, p.proacl
           from (values ('public.pi_reconciliation_log_immutable()', false),
                        ('public.pi_reconcile_open_operation(text, text, text, timestamptz, text, text, numeric, boolean)', true)) f(sig, secdef)
           left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(f.sig)
           left join pg_catalog.pg_language l on l.oid = p.prolang loop
    if r.oid is null then raise exception 'tool function % missing after install', r.sig using errcode = 'P0001'; end if;
    if pg_catalog.pg_get_userbyid(r.proowner) <> 'postgres' then
      raise exception 'tool function % has an incompatible owner (%) after install; install aborted', r.sig, pg_catalog.pg_get_userbyid(r.proowner) using errcode = 'P0001'; end if;
    if r.lanname <> 'plpgsql' or r.prosecdef <> r.secdef or r.proconfig is distinct from array['search_path=""'] then
      raise exception 'tool function % has incompatible attributes (language %, security definer %, config %); install aborted',
        r.sig, r.lanname, r.prosecdef, r.proconfig using errcode = 'P0001'; end if;
    if exists (select 1 from pg_catalog.aclexplode(coalesce(r.proacl, pg_catalog.acldefault('f', r.proowner))) x where x.grantee <> r.proowner) then
      raise exception 'tool function % has incompatible privileges (granted to roles other than the owner); install aborted', r.sig using errcode = 'P0001'; end if;
  end loop;
end $$;
drop function public.pi_reconciliation_security_problem();

commit;
