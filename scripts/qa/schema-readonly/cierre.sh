#!/usr/bin/env bash
# Integration-close rehearsal (USD 0). PRODUCTION IS ONLY READ: every statement runs in BEGIN TRANSACTION READ ONLY …
# ROLLBACK, and pg_dump takes its own read-only snapshot. Everything that writes runs on a DISPOSABLE local PostgreSQL
# 17 built from production's schema, its economic tables (pi_* only: ids and amounts, no user content) and both
# migration registries. Nothing is uploaded: the dumps stay on the runner and are deleted at the end; only counts,
# md5 digests and file names are printed.
#   1) exact reconciliation of the two registries (reconcile.py), forward + rollback;
#   2) the repo's real apply tool (scripts/apply-supabase-migration.ts): "apply all" before/after reconciling, then
#      120000 → 130000 → 140000 one file at a time (migration_file), as the release procedure prescribes;
#   3) permissions, functions, existing data and economic invariants after each step; 4) rollback to the exact start.
set -uo pipefail
R=$(git rev-parse --show-toplevel); OUT=${OUT:-$PWD/cierre-out}; mkdir -p "$OUT"; T=$(mktemp -d)
PGBIN=/usr/lib/postgresql/17/bin
fails=0; pass(){ echo "PASS $*"; }; fail(){ echo "FAIL $*"; fails=$((fails+1)); }
URL=$(cd "$R" && npx tsx -e 'import { resolveConnection } from "./scripts/lib/supabase-db"; const c = resolveConnection(); if (!c) { process.exit(3) } process.stdout.write(c.connectionString)') || { echo "FAIL no DB credential"; exit 1; }
PW=$(node -e 'const u=new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.password))' "$URL"); echo "::add-mask::$PW"; echo "::add-mask::$URL"
mask(){ sed "s/$PW/***/g"; }
"$PGBIN/psql" "$URL" -X -c "select 1" >/dev/null 2>"$T/err" || { echo "FAIL connect: $(mask < "$T/err" | head -3)"; exit 1; }
ro=$(printf 'begin transaction read only;\nshow transaction_read_only;\nrollback;\n' | "$PGBIN/psql" "$URL" -X -qAt 2>&1 | grep -E '^(on|off)$'); [ "$ro" = on ] || { echo "FAIL transaction is not read-only ($ro): stop"; exit 1; }
w=$(printf 'begin transaction read only;\ncreate temp table _probe(x int);\nrollback;\n' | "$PGBIN/psql" "$URL" -X -qAt 2>&1); echo "$w" | grep -q "read-only transaction" || { echo "FAIL write probe not refused: stop"; exit 1; }
pass "production session: explicit READ ONLY transaction honoured, write probe refused"
RO(){ { printf 'begin transaction read only;\n'; cat "$1"; printf '\nrollback;\n'; } | "$PGBIN/psql" "$URL" -X -v ON_ERROR_STOP=1 2>"$T/ro.err"; local s=$?; mask < "$T/ro.err" | grep -v '^$' | head -5; return $s; }

echo "== 1. Production (read-only): catalog, impact aggregates, schema + pi_* data + registries"
RO "$R/scripts/qa/schema-readonly/catalog.sql" > "$OUT/catalog.txt"; echo "catalog exit $?"
RO "$R/scripts/qa/schema-readonly/impact.sql" > "$OUT/impact.txt"; echo "impact exit $?"
grep -q '^session_read_only | on$' "$OUT/impact.txt" && pass "impact queries ran with transaction_read_only=on" || fail "impact read-only flag not confirmed"
grep -E '^(impact|prod_rows|prod_supply_state)' "$OUT/impact.txt"
grep -E '^(migration|marker|trigger|privilege|count) ' "$OUT/catalog.txt"
"$PGBIN/pg_dump" "$URL" --schema-only --no-owner --no-comments -n public -f "$T/public.sql" 2>"$T/d1" || { echo "FAIL pg_dump schema: $(mask < "$T/d1" | head -3)"; exit 1; }
"$PGBIN/pg_dump" "$URL" --data-only --disable-triggers --no-owner -t 'public.pi_*' -t public._migrations_applied -f "$T/data.sql" 2>"$T/d2" || { echo "FAIL pg_dump data: $(mask < "$T/d2" | head -3)"; exit 1; }
"$PGBIN/pg_dump" "$URL" --no-owner --no-privileges -n supabase_migrations -f "$T/sm.sql" 2>"$T/d3" || { echo "FAIL pg_dump registry: $(mask < "$T/d3" | head -3)"; exit 1; }
echo "INFO dumps kept on the runner only: schema $(wc -l < "$T/public.sql") lines, pi_* data $(wc -c < "$T/data.sql") bytes, schema_migrations $(wc -l < "$T/sm.sql") lines"
unset PGOPTIONS

# --- tree to be released: #205 (integration of #201 → #199 → #200) has the same supabase/ as the sequential merge ---
INT_REF=${INT_REF:-claude/integracion-201-199-200}
git -C "$R" fetch -q --depth=1 origin "$INT_REF" && git -C "$R" worktree add -q --detach "$T/int" FETCH_HEAD && INT="$T/int" || { echo "FAIL cannot check out $INT_REF"; exit 1; }
ln -s "$R/node_modules" "$INT/node_modules"
echo "INFO tree to be released: $INT_REF @ $(git -C "$INT" rev-parse HEAD)"

echo "== 2. Exact reconciliation (computed from the production registries and schema)"
grep '^registered | ' "$OUT/catalog.txt" | sed 's/^registered | //; s/ | /|/' > "$T/registered.txt"
grep '^applied_registry | ' "$OUT/catalog.txt" | sed 's/^applied_registry | //' > "$T/applied.txt"
echo "INFO schema_migrations: $(wc -l < "$T/registered.txt") rows; _migrations_applied: $(tr ',' '\n' < "$T/applied.txt" | grep -c .) names"
python3 -I "$R/scripts/qa/schema-readonly/history.py" "$T/registered.txt" "$INT/supabase/migrations" "$INT/supabase/proposals" "$T/public.sql" "$T/applied.txt" > "$OUT/history.txt"
grep -E 'registry-only|PARTIAL|NOT_APPLIED|SUMMARY' "$OUT/history.txt"
python3 -I "$R/scripts/qa/schema-readonly/reconcile.py" "$OUT/history.txt" "$OUT/catalog.txt" "$INT/supabase/migrations" "$OUT/reconcile"
if [ -f "$INT/docs/ops/20261024_register_applied_migrations.sql" ]; then
  grep -oE "'[^']+\.sql'" "$INT/docs/ops/20261024_register_applied_migrations.sql" | tr -d "'" | sort > "$T/ops.txt"
  grep '^RECONCILE A ' <(python3 -I "$R/scripts/qa/schema-readonly/reconcile.py" "$OUT/history.txt" "$OUT/catalog.txt" "$INT/supabase/migrations" "$T/rc2") | sed 's/^RECONCILE A //' | sort > "$T/a.txt"
  diff -q "$T/ops.txt" "$T/a.txt" >/dev/null && pass "fresh list A == docs/ops/20261024_register_applied_migrations.sql ($(wc -l < "$T/a.txt") names)" || { fail "fresh list A differs from docs/ops (registry changed?)"; diff "$T/ops.txt" "$T/a.txt"; }
fi

echo "== 3. Disposable replica: production schema + pi_* data + both registries"
L=$T/local; "$PGBIN/initdb" -D "$L" -U postgres --auth=trust >/dev/null; "$PGBIN/pg_ctl" -D "$L" -o "-p 55990 -k $T -c listen_addresses=''" -l "$T/pg.log" -w start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$L" -m fast stop >/dev/null 2>&1 || true; rm -rf "$T/public.sql" "$T/data.sql" "$T/sm.sql"' EXIT
LQ="$PGBIN/psql -h $T -p 55990 -U postgres -X -q"
$LQ -d postgres -c "create database replica" >/dev/null
$LQ -d replica -f "$INT/scripts/harness/e2e/infra/stubs.sql" >/dev/null 2>&1
$LQ -d replica -c "create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create extension if not exists \"uuid-ossp\" with schema extensions" >/dev/null 2>&1
# the schema dump keeps production's privileges (REVOKE … FROM PUBLIC + GRANTs); GRANTs to Supabase-internal roles absent here fail harmlessly
$LQ -d replica -f "$T/public.sql" > "$T/restore.log" 2>&1; echo "INFO schema restore: $(grep -c ERROR "$T/restore.log") errors ($(grep ERROR "$T/restore.log" | grep -c 'role .* does not exist') of them grants to Supabase-internal roles)"; grep ERROR "$T/restore.log" | grep -v 'role .* does not exist' | sort | uniq -c | sort -rn | head -5
acl(){ $LQ -d replica -At -c "select 'acl', p.oid::regprocedure::text, has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('pi_documentary_resume_requires_budget','pi_recovery_resume_authorization','pi_open_spend_authorization','pi_spend_authorization_usage','pi_supply_state','pi_supply_state_pre_studio','pi_studio_call_counts','pi_supply_spend','pi_submit_with_supply','podcast_studio_operations_cap') order by 2"; }
acl > "$T/acl0"
grep '^prod_acl' "$OUT/impact.txt" | awk -F' [|] ' '{print "acl|" $2 "|" $4 "|" $5}' | sort > "$T/acl_prod"
grep -E "^acl\|($(cut -d'|' -f2 "$T/acl_prod" | sed 's/[()]/\\&/g' | paste -sd'|'))\|" "$T/acl0" | sort > "$T/acl0p"
diff -q "$T/acl_prod" "$T/acl0p" >/dev/null && pass "replica anon/authenticated EXECUTE == production for every touched function" || { echo "INFO replica ACLs differ from production (Supabase default privileges not reproducible); the migration check below compares replica before/after:"; diff "$T/acl_prod" "$T/acl0p"; }
echo "INFO production anon/authenticated EXECUTE on touched functions:"; grep '^prod_acl' "$OUT/impact.txt"
$LQ -d replica -f "$T/sm.sql" > "$T/restore2.log" 2>&1; echo "INFO registry restore: $(grep -c ERROR "$T/restore2.log") errors"; grep ERROR "$T/restore2.log" | head -3
$LQ -d replica -f "$T/data.sql" > "$T/restore3.log" 2>&1; echo "INFO pi_* data restore: $(grep -c ERROR "$T/restore3.log") errors"; grep ERROR "$T/restore3.log" | head -3
rows_ok=1
while IFS='|' read -r _ t n; do t=$(echo $t); n=$(echo $n)
  if [ "$t" = supabase_migrations.schema_migrations ]; then r=$($LQ -d replica -At -c "select count(*) from supabase_migrations.schema_migrations"); else r=$($LQ -d replica -At -c "select count(*) from public.\"$t\""); fi
  [ "$r" = "$n" ] || { rows_ok=0; echo "  rows $t: production $n, replica $r"; }
done < <(grep '^prod_rows' "$OUT/impact.txt")
[ $rows_ok = 1 ] && pass "replica row counts == production for every copied table ($(grep -c '^prod_rows' "$OUT/impact.txt") tables)" || fail "replica row counts differ"
same=1; while IFS='|' read -r _ p h; do p=$(echo $p); h=$(echo $h); r=$($LQ -d replica -At -c "select md5(public.pi_supply_state('$p')::text)"); [ "$r" = "$h" ] || { same=0; echo "  supply_state $p differs (time window?)"; }; done < <(grep '^prod_supply_state' "$OUT/impact.txt")
[ $same = 1 ] && pass "replica pi_supply_state(provider) == production for every provider" || echo "INFO replica pi_supply_state differs from production for some provider (time-dependent windows); before/after below is what counts"

# invariants snapshot: registries, touched function bodies, pi_* data, economic answers
snap(){ $LQ -d replica -At <<'SQL'
select 'reg_ma', md5(coalesce(string_agg(name, ',' order by name), '')) from public._migrations_applied;
select 'reg_sm', md5(coalesce(string_agg(version || ':' || coalesce(name, ''), ',' order by version), '')) from supabase_migrations.schema_migrations;
select 'fn', p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('pi_documentary_resume_requires_budget','pi_recovery_resume_authorization','pi_open_spend_authorization',
  'pi_spend_authorization_usage','pi_supply_state','pi_supply_spend','pi_submit_with_supply') order by 2;
select 'tables_studio', to_regclass('public.podcast_studio_episodes') is not null, to_regclass('public.podcast_studio_operations') is not null;
SQL
}
data(){ $LQ -d replica -At <<'SQL'
select 'data', c.relname, (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(t::text, ''|'' order by t::text), '''')) h from public.%I t', c.relname), false, true, '')))[1]::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'pi\_%' order by 2;
select 'supply', provider, md5((public.pi_supply_state(provider) - 'studioActiveCalls' - 'studioTodayCalls')::text) from public.pi_supply_policies order by 2;
select 'usage', project_id, md5(public.pi_spend_authorization_usage(project_id)::text) from public.pi_spend_authorizations order by 2;
SQL
}
snap > "$T/s0"; data > "$T/d0"; sleep 3; data > "$T/d0b"
noise=$(diff <(grep '^supply' "$T/d0") <(grep '^supply' "$T/d0b") | grep -c '^<' || true); echo "INFO supply-state time noise: $noise provider(s) change between two reads 3 s apart with no change at all"
echo "INFO start state: $(grep -c '^fn' "$T/s0") functions, $(grep -c '^data' "$T/d0") pi_* tables, $(grep -c '^supply' "$T/d0") providers, $(grep -c '^usage' "$T/d0") authorizations"

LURL="postgresql://postgres@localhost/replica?host=$T&port=55990"
APPLY(){ # $1 = db, $2 = tree, $3 = optional migration_file. Never production: the URL is a local socket, other secrets unset.
  local u="postgresql://postgres@localhost/$1?host=$T&port=55990"; case "$u" in *supabase*|*pooler*|*amazonaws*) echo "FAIL refusing non-local URL"; exit 1;; esac
  (cd "$2" && env -u SUPABASE_DB_PASSWORD -u SUPABASE_PROJECT_REF -u SUPABASE_URL -u SUPABASE_DB_HOST -u SUPABASE_DB_PORT SUPABASE_DB_URL="$u" \
    timeout 300 npx tsx scripts/apply-supabase-migration.ts ${3:-} 2>&1); }

echo "== 4. Risk check: the repo's 'apply all pending' on a COPY of the replica BEFORE reconciling"
$LQ -d postgres -c "create database risk template replica" >/dev/null
APPLY risk "$INT" > "$T/risk.log"; rc=$?; grep -E 'DETENIDO|Aplicando|FALLÓ|Resumen|reconciliada|error' "$T/risk.log" | head -12; echo "INFO apply-all before reconciliation: exit $rc"
$LQ -d postgres -c "drop database risk" >/dev/null

echo "== 5. Reconciliation A on the replica (forward), then 'apply all' must be a no-op"
$LQ -d replica -v ON_ERROR_STOP=1 -f "$OUT/reconcile/A_register_migrations_applied.sql" >/dev/null 2>"$T/a.err" && pass "A applied" || fail "A: $(head -3 "$T/a.err")"
$LQ -d replica -v ON_ERROR_STOP=1 -f "$OUT/reconcile/A_register_migrations_applied.sql" >/dev/null 2>"$T/a2.err" && fail "A ran twice (precondition not enforced)" || pass "A refuses a second run: $(grep -o 'precondition failed' "$T/a2.err" | head -1)"
missing=$(for f in "$INT"/supabase/migrations/*.sql; do b=$(basename "$f"); [ "$($LQ -d replica -At -c "select count(*) from public._migrations_applied where name='$b'")" = 1 ] || echo "$b"; done)
[ -z "$missing" ] && pass "every file in supabase/migrations is registered in _migrations_applied" || fail "still unregistered: $missing"
APPLY replica "$INT" > "$T/all.log"; rc=$?; grep -E 'DETENIDO|Aplicando|FALLÓ|Resumen' "$T/all.log" | head -6
[ $rc = 0 ] && grep -q 'Resumen: 0 aplicada(s)' "$T/all.log" && pass "'apply all pending' after A: exit 0, 0 applied (nothing re-executed)" || fail "'apply all pending' after A: exit $rc"
snap > "$T/s1"; data > "$T/d1"; diff -q <(grep -v '^reg_ma' "$T/s1") <(grep -v '^reg_ma' "$T/s0") >/dev/null && diff -q <(grep -v '^supply' "$T/d1") <(grep -v '^supply' "$T/d0") >/dev/null && pass "A changed only _migrations_applied (functions, pi_* data, economic answers identical)" || fail "A changed more than the registry"

echo "== 6. Sequential release 120000 → 130000 → 140000 with the real tool (migration_file, one per run)"
REL=$T/rel; cp -a "$INT" "$REL"; rm -f "$REL/node_modules"; ln -s "$R/node_modules" "$REL/node_modules"
for v in 20261024120000_resume_authorization_ref_match 20261024130000_spend_authorization_baseline_fix 20261024140000_podcast_v3_studio; do cp "$INT/supabase/proposals/$v.sql" "$REL/supabase/migrations/"; done
marker(){ $LQ -d replica -At -c "$1"; }
M120="select coalesce(bool_or(pg_get_functiondef(p.oid) like '%r.authorization_ref = b.authorization_ref%'), false) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='pi_documentary_resume_requires_budget'"
M130="select coalesce(bool_or(pg_get_functiondef(p.oid) like '%status <> ''RESERVED''%'), false) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='pi_open_spend_authorization'"
M140="select to_regprocedure('public.pi_supply_state_pre_studio(text)') is not null and to_regclass('public.podcast_studio_operations') is not null"
step=0
for v in 20261024120000_resume_authorization_ref_match 20261024130000_spend_authorization_baseline_fix 20261024140000_podcast_v3_studio; do
  step=$((step+1)); APPLY replica "$REL" "$v.sql" > "$T/m$step.log"; rc=$?
  grep -E 'DETENIDO|FALLÓ|Resumen|WARNING|aviso' "$T/m$step.log" | head -4
  [ $rc = 0 ] && grep -q 'Resumen: 1 aplicada(s)' "$T/m$step.log" && pass "tool applied $v.sql (exit 0) and registered it" || fail "tool on $v.sql: exit $rc"
  m=$(marker "$([ $step = 1 ] && echo "$M120" || { [ $step = 2 ] && echo "$M130" || echo "$M140"; })"); [ "$m" = t ] && pass "marker for $v present" || fail "marker for $v absent"
done
APPLY replica "$REL" 20261024140000_podcast_v3_studio.sql > "$T/m4.log"; grep -q 'ya está registrada' "$T/m4.log" && pass "re-running the tool on 140000 skips it (registered)" || fail "tool re-run on 140000 did not skip"

echo "== 7. After the three migrations: permissions, functions, existing data, economic limits"
$LQ -d replica -At <<'SQL' > "$T/perm.txt"
select 'perm', r.rolname, p.oid::regprocedure::text, has_function_privilege(r.rolname, p.oid, 'execute'), p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join pg_roles r
  where n.nspname = 'public' and r.rolname in ('anon', 'authenticated', 'service_role') and p.proname in ('pi_documentary_resume_requires_budget','pi_recovery_resume_authorization',
  'pi_open_spend_authorization','pi_spend_authorization_usage','pi_supply_state','pi_supply_state_pre_studio','pi_studio_call_counts','pi_supply_spend','podcast_studio_operations_cap') order by 2, 3;
select 'rls', c.relname, c.relrowsecurity, has_table_privilege('anon', c.oid, 'insert'), has_table_privilege('authenticated', c.oid, 'insert,update,delete')
  from pg_class c where c.oid in (to_regclass('public.podcast_studio_episodes'), to_regclass('public.podcast_studio_operations'));
SQL
acl > "$T/acl3"
# a function the migration did NOT create must keep its ACL; a function it created must be closed to anon/authenticated
widened=$(join -t'|' -j2 <(sort -t'|' -k2,2 "$T/acl0") <(sort -t'|' -k2,2 "$T/acl3") | awk -F'|' '($3=="f" && $6=="t") || ($4=="f" && $7=="t")')
newopen=$(comm -13 <(cut -d'|' -f2 "$T/acl0" | sort) <(cut -d'|' -f2 "$T/acl3" | sort) | while read -r f; do grep -F "acl|$f|" "$T/acl3"; done | awk -F'|' '$3=="t" || $4=="t"')
[ -z "$widened$newopen" ] && pass "the three migrations widen no EXECUTE privilege, and every function they create is closed to anon/authenticated" || { fail "privileges widened:"; echo "$widened$newopen"; }
nosp=$(grep '^perm|service_role' "$T/perm.txt" | awk -F'|' '$3 !~ /requires_budget|_cap\(/ && $4=="f"'); [ -z "$nosp" ] && pass "service_role can EXECUTE every RPC the app calls" || { fail "service_role lacks execute:"; echo "$nosp"; }
nopath=$(grep '^perm|service_role' "$T/perm.txt" | awk -F'|' '$6 !~ /search_path=""/'); [ -z "$nopath" ] && pass "every touched function pins search_path=''" || { fail "functions without search_path='':"; echo "$nopath"; }
grep '^rls' "$T/perm.txt" | awk -F'|' '{ if ($3=="t" && $4=="f" && $5=="f") print "PASS studio table " $2 ": RLS on, anon/authenticated cannot write"; else print "FAIL studio table " $2 ": " $0 }' | tee -a "$T/rls.out"
fails=$((fails + $(grep -c '^FAIL' "$T/rls.out" || true)))
data > "$T/d3"
diff -q <(grep '^data' "$T/d3") <(grep '^data' "$T/d0") >/dev/null && pass "the three migrations changed no existing pi_* row" || fail "existing pi_* rows changed"
# same instant, one statement: the new wrapper (minus its two studio counters, both 0) == the pre-studio function
same=$($LQ -d replica -At -c "select count(*) filter (where (public.pi_supply_state(provider) - 'studioActiveCalls' - 'studioTodayCalls') = public.pi_supply_state_pre_studio(provider)), count(*), count(*) filter (where coalesce((public.pi_supply_state(provider)->>'studioActiveCalls')::int, 0) = 0 and coalesce((public.pi_supply_state(provider)->>'studioTodayCalls')::int, 0) = 0) from public.pi_supply_policies")
IFS='|' read -r eq tot zero <<< "$same"
[ "$eq" = "$tot" ] && [ "$zero" = "$tot" ] && pass "pi_supply_state after 140000 == pre-studio state for all $tot providers at the same instant (only adds studio counters = 0; no limit, level or spend moved)" || fail "supply wrapper changes state ($eq/$tot equal, $zero/$tot zero counters)"
chg=$(diff <(grep '^supply' "$T/d0") <(grep '^supply' "$T/d3") | grep -c '^<' || true); echo "INFO supply-state md5 before vs after (seconds apart): $chg provider(s) differ; time noise measured above: $noise"
diff -q <(grep '^usage' "$T/d3") <(grep '^usage' "$T/d0") >/dev/null && pass "pi_spend_authorization_usage identical for every existing authorization" || fail "authorization usage changed"
# economic limits on the migrated replica (synthetic owner/episode, inside a transaction that is rolled back)
$LQ -d replica -v ON_ERROR_STOP=0 -At > "$T/lim.txt" 2>&1 <<'SQL'
begin;
select 'cap_over_50', (select count(*) from pg_constraint where conname = 'podcast_studio_episodes_authorized_max');
select 'studio_counts_empty', public.pi_studio_call_counts('heygen', now() - interval '1 day', null)::text;
rollback;
SQL
grep -E '^(cap_over_50|studio_counts_empty|supply_wrapper)' "$T/lim.txt"; grep -q '^cap_over_50|1' "$T/lim.txt" && pass "studio authorization hard cap (≤ USD 50) constraint present" || fail "studio cap constraint missing"
echo "INFO E1–E8 (budgets, caps, owner, idempotency, stale reservations) already PASS 29/0/0 on the production schema + these proposals (run 40132895580) and on #200 @ 1794224 (local); not repeated."

echo "== 8. Recovery: rollback 140000 → 130000 → 120000, de-register, rollback A → exact start state"
for v in 20261024140000_podcast_v3_studio 20261024130000_spend_authorization_baseline_fix 20261024120000_resume_authorization_ref_match; do
  $LQ -d replica -v ON_ERROR_STOP=1 -f "$INT/supabase/proposals/$v.rollback.sql" >/dev/null 2>"$T/rb.err" && $LQ -d replica -c "delete from public._migrations_applied where name = '$v.sql'" >/dev/null && pass "rollback $v + de-register" || fail "rollback $v: $(head -2 "$T/rb.err")"
done
snap > "$T/s4"; data > "$T/d4"
diff -q <(grep -v '^reg_ma' "$T/s4") <(grep -v '^reg_ma' "$T/s0") >/dev/null && pass "after rollbacks: every touched function body and the studio tables are back to the production start state (md5)" || { fail "function bodies differ from start after rollback"; diff <(grep -v '^reg_ma' "$T/s0") <(grep -v '^reg_ma' "$T/s4"); }
diff -q <(grep -v '^supply' "$T/d4") <(grep -v '^supply' "$T/d0") >/dev/null && pass "after rollbacks: pi_* data and authorization usage identical to start" || fail "data differs after rollback"
[ "$($LQ -d replica -At -c "select to_regprocedure('public.pi_supply_state_pre_studio(text)') is null")" = t ] && pass "after rollbacks: pi_supply_state is the original function again (no wrapper)" || fail "wrapper still present after rollback"
$LQ -d replica -v ON_ERROR_STOP=1 -f "$OUT/reconcile/A_register_migrations_applied.rollback.sql" >/dev/null 2>&1 && snap > "$T/s5" && diff -q "$T/s5" "$T/s0" >/dev/null && pass "rollback A: _migrations_applied identical to production's (md5)" || fail "rollback A did not restore the registry"
$LQ -d replica -v ON_ERROR_STOP=1 -f "$OUT/reconcile/B_register_schema_migrations.sql" >/dev/null 2>"$T/b.err" && pass "B (optional, schema_migrations) applies" || fail "B: $(head -2 "$T/b.err")"
$LQ -d replica -v ON_ERROR_STOP=1 -f "$OUT/reconcile/B_register_schema_migrations.rollback.sql" >/dev/null 2>&1 && snap > "$T/s6" && diff -q "$T/s6" "$T/s0" >/dev/null && pass "rollback B: schema_migrations identical to production's (md5)" || fail "rollback B did not restore schema_migrations"

echo "== 9. Repeatability: the full forward path again from the restored start"
$LQ -d replica -v ON_ERROR_STOP=1 -f "$OUT/reconcile/A_register_migrations_applied.sql" >/dev/null 2>&1 || fail "A second forward"
ok=1; for v in 20261024120000_resume_authorization_ref_match 20261024130000_spend_authorization_baseline_fix 20261024140000_podcast_v3_studio; do APPLY replica "$REL" "$v.sql" > "$T/r.log" || ok=0; grep -q 'Resumen: 1 aplicada(s)' "$T/r.log" || ok=0; done
[ $ok = 1 ] && [ "$(marker "$M120")$(marker "$M130")$(marker "$M140")" = ttt ] && pass "forward path repeatable after a full rollback (A + 120000 → 130000 → 140000, markers t t t)" || fail "forward path not repeatable"

echo "== reconciliation files (to be applied in production only with the owner's authorization):"
for f in "$OUT"/reconcile/*.sql; do echo "--- $(basename "$f") sha256 $(sha256sum "$f" | cut -c1-16)"; cat "$f"; done
echo "RESULT cierre: $fails FAIL"
[ $fails = 0 ]
