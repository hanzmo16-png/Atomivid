#!/usr/bin/env bash
# O2 verifier mutants (T-20261026-1901-chatgpt-01, R1/R2). USD 0, NO production: a DISPOSABLE local PostgreSQL only
# (unix socket; refuses anything else). Builds a synthetic schema from the repo (stubs + supabase/migrations + PR198),
# then proves every mutant of the identity (both bodies, trigger definition) and of the protected data (jobs, pi_*,
# snapshot shape) is rejected with a non-zero exit and exactly the expected reason, while the valid path still passes.
# Usage: PGHOST=<socket dir> PGPORT=<port> bash o2-mutantes.sh   (or no env: creates its own cluster; not as root)
set -uo pipefail
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel); O2="$R/scripts/qa/schema-readonly/o2.sh"; T=$(mktemp -d)
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}; export PSQL=$PGBIN/psql
NAME=20261024120000_resume_authorization_ref_match.sql
fails=0; pass(){ echo "PASS $*"; }; fail(){ echo "FAIL $*"; fails=$((fails+1)); }
if [ -z "${PGHOST:-}" ]; then
  "$PGBIN/initdb" -D "$T/d" -U postgres --auth=trust >/dev/null || exit 1
  "$PGBIN/pg_ctl" -D "$T/d" -o "-p 55994 -k $T -c listen_addresses=''" -l "$T/pg.log" -w start >/dev/null || exit 1
  trap '"$PGBIN/pg_ctl" -D "$T/d" -m fast stop >/dev/null 2>&1' EXIT; export PGHOST=$T PGPORT=55994
fi
case "$PGHOST" in /*) ;; *) echo "FAIL refusing non-socket PGHOST"; exit 2;; esac
P(){ "$PGBIN/psql" -h "$PGHOST" -p "$PGPORT" -U postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
U(){ echo "postgresql://postgres@localhost/$1?host=$PGHOST&port=$PGPORT"; }
snap(){ bash "$O2" snap "$(U "$2")" "$T/$1.snap" > "$T/$1.log" 2>&1 || { fail "snapshot $1: $(grep FAIL "$T/$1.log" | head -1)"; echo "RESULT o2-mutantes: $fails FAIL (aborted)"; exit 1; }; }
# exactly the expected FAIL lines, non-zero exit
rejects(){ local label=$1 n=$2 out=$3; shift 3; local f c miss=""; f=$(grep '^FAIL' "$out"); c=$(printf '%s' "$f" | grep -c '^FAIL')
  for r in "$@"; do printf '%s\n' "$f" | grep -qF -- "$r" || miss="$miss [$r]"; done
  [ "${rc:-1}" != 0 ] && [ -z "$miss" ] && [ "$c" = "$n" ] && pass "$label: exit $rc, rejected for exactly the expected $n reason(s)" || { fail "$label: exit ${rc:-?} missing:${miss:- none} fail_lines=$c (want $n)"; printf '%s\n' "$f" | head -6; }; }
run(){ local out=$1; shift; bash "$O2" "$@" > "$out" 2>&1; rc=$?; }

echo "== synthetic disposable schema (repo SQL only)"
for d in m0 pre0 post0 mpre_trg mpre_rpc mpre_def mpost_trg mpost_rpc mpost_def j_inactive j_exhausted j_pi conc; do P -d postgres -c "drop database if exists $d" >/dev/null; done; P -d postgres -c "create database m0" >/dev/null
P -d m0 -f "$R/scripts/harness/e2e/infra/stubs.sql" >/dev/null 2>&1
P -d m0 -c "create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key, name text); create table if not exists public._migrations_applied(name text primary key, applied_at timestamptz default now())" >/dev/null 2>&1
for f in "$R"/supabase/migrations/*.sql; do case $f in *"$NAME") continue;; esac; "$PGBIN/psql" -h "$PGHOST" -p "$PGPORT" -U postgres -X -q -d m0 -f "$f" >/dev/null 2>&1; done
P -d m0 -c "create table if not exists public.pi_paid_operations(id serial primary key, status text, project_id text)" >/dev/null 2>&1
"$PGBIN/psql" -h "$PGHOST" -p "$PGPORT" -U postgres -X -q -d m0 -f "$R/supabase/proposals/20261024000000_spend_authorizations.sql" >/dev/null 2>&1
P -d m0 -f "$R/supabase/proposals/${NAME%.sql}.rollback.sql" >/dev/null 2>&1   # PR198 bodies exactly (audited)
P -d m0 -c "revoke all on function public.pi_documentary_resume_requires_budget() from public, anon, authenticated; grant execute on function public.pi_documentary_resume_requires_budget() to service_role; revoke all on function public.pi_recovery_resume_authorization(text,text) from public, anon, authenticated; grant execute on function public.pi_recovery_resume_authorization(text,text) to service_role" >/dev/null
P -d m0 -c "insert into auth.users(id, email) values ('cccccccc-0000-4000-8000-0000000000d1', 'm@x') on conflict do nothing;
  insert into public.documentary_script_jobs(id, user_id, input_hash, topic, status, retry_count) values
  ('d0000000-0000-4000-8000-0000000003a1', 'cccccccc-0000-4000-8000-0000000000d1', 'h1', 'inactivo', 'completed', 0),
  ('d0000000-0000-4000-8000-0000000003a2', 'cccccccc-0000-4000-8000-0000000000d1', 'h2', 'fallido', 'failed', 2);
  insert into public.pi_paid_operations(status, project_id) values ('COMPLETED', 'p-m')" >/dev/null 2>&1 || P -d m0 -c "select 1" >/dev/null
P -d postgres -c "create database pre0 template m0" >/dev/null; snap s_pre pre0

echo "== positives (valid path keeps passing)"
run "$T/p1" pre-objects "$T/s_pre.snap"; [ $rc = 0 ] && pass "pre-objects on the audited PR198 state: 0 FAIL" || { fail "pre-objects positive"; grep FAIL "$T/p1"; }
snap s_pre2 pre0; run "$T/p2" same "$T/s_pre.snap" "$T/s_pre2.snap"; [ $rc = 0 ] && pass "R1 identical snapshot: same passes" || { fail "same positive"; grep FAIL "$T/p2"; }
P -d postgres -c "create database post0 template m0" >/dev/null; P -d post0 -f "$R/supabase/migrations/$NAME" >/dev/null 2>&1; snap s_post post0
run "$T/p3" post-objects "$T/s_post.snap"; [ $rc = 0 ] && pass "post-objects on the exact audited migration: 0 FAIL" || { fail "post-objects positive"; grep FAIL "$T/p3"; }

echo "== R2 mutants: identity (marker, owner, ACL, count/enabled unchanged)"
mut(){ # $1 db, $2 base db, $3 SQL
  P -d postgres -c "create database $1 template $2" >/dev/null; P -d "$1" -c "$3" >/dev/null 2>"$T/$1.err" || { fail "mutant $1 setup: $(head -1 "$T/$1.err")"; return 1; }; snap "$1" "$1"; }
TRG_PRE=$(python3 -I -c 'import re,sys; s=open(sys.argv[1]).read(); m=[x for x in re.finditer(r"create or replace function public\.pi_documentary_resume_requires_budget\(\).*?as \$\$(.*?)\$\$", s, re.S)][-1]; print(m.group(1))' "$R/supabase/proposals/${NAME%.sql}.rollback.sql")
TRG_POST=$(python3 -I -c 'import re,sys; s=open(sys.argv[1]).read(); m=[x for x in re.finditer(r"create or replace function public\.pi_documentary_resume_requires_budget\(\).*?as \$\$(.*?)\$\$", s, re.S)][-1]; print(m.group(1))' "$R/supabase/migrations/$NAME")
# pre: trigger body (one character of the message), RPC body (one condition), trigger definition (extra column)
mut mpre_trg m0 "create or replace function public.pi_documentary_resume_requires_budget() returns trigger language plpgsql security invoker set search_path = '' as \$m\$${TRG_PRE/before requeueing/before re-queueing}\$m\$" \
  && { run "$T/m1" pre-objects "$T/mpre_trg.snap"; rejects "R2 pre: trigger body mutated" 1 "$T/m1" "trigger fn body (prosrc md5 | functiondef md5) == PR198"; }
mut mpre_rpc m0 "create or replace function public.pi_recovery_resume_authorization(p_project_id text, p_authorization_ref text) returns jsonb language sql stable security definer set search_path = '' as \$m\$ select jsonb_build_object('authorized', count(*) > 0, 'transactionId', max(r.transaction_id)) from public.pi_recovery_resume_authorizations r where r.project_id = p_project_id and r.authorization_ref = p_authorization_ref and r.transaction_id is not null \$m\$" \
  && { run "$T/m2" pre-objects "$T/mpre_rpc.snap"; rejects "R2 pre: RPC body mutated" 1 "$T/m2" "RPC body (prosrc md5 | functiondef md5) == PR198"; }
mut mpre_def m0 "drop trigger pi_documentary_resume_requires_budget on public.documentary_script_jobs; create trigger pi_documentary_resume_requires_budget before update of status, retry_count on public.documentary_script_jobs for each row execute function public.pi_documentary_resume_requires_budget()" \
  && { run "$T/m3" pre-objects "$T/mpre_def.snap"; rejects "R2 pre: trigger definition mutated (count 1, enabled O)" 1 "$T/m3" "trigger: count|enabled|full definition"; }
# post: same three, the 120000 marker text kept in the trigger body
mut mpost_trg post0 "create or replace function public.pi_documentary_resume_requires_budget() returns trigger language plpgsql security definer set search_path = '' as \$m\$${TRG_POST/needs an ACTIVE recovery budget/needs an active recovery budget}\$m\$" \
  && { grep -q '^m120|t' "$T/mpost_trg.snap" && pass "R2 post trigger mutant keeps marker 120000 = t"; run "$T/m4" post-objects "$T/mpost_trg.snap"; rejects "R2 post: trigger body mutated" 1 "$T/m4" "trigger fn body (prosrc md5) == migration 13dffaa6"; }
mut mpost_rpc post0 "create or replace function public.pi_recovery_resume_authorization(p_project_id text, p_authorization_ref text) returns jsonb language sql stable security definer set search_path = '' as \$m\$ select jsonb_build_object('authorized', count(*) > 0, 'transactionId', max(r.transaction_id)) from public.pi_recovery_resume_authorizations r where r.project_id = p_project_id and r.authorization_ref = p_authorization_ref and length(trim(coalesce(p_authorization_ref, ''))) > 0 and r.transaction_id is not null \$m\$" \
  && { run "$T/m5" post-objects "$T/mpost_rpc.snap"; rejects "R2 post: RPC body mutated (empty project_id no longer refused)" 1 "$T/m5" "RPC body (prosrc md5) == migration 13dffaa6"; }
mut mpost_def post0 "drop trigger pi_documentary_resume_requires_budget on public.documentary_script_jobs; create trigger pi_documentary_resume_requires_budget before update of status, retry_count on public.documentary_script_jobs for each row execute function public.pi_documentary_resume_requires_budget()" \
  && { run "$T/m6" post-objects "$T/mpost_def.snap"; rejects "R2 post: trigger definition mutated (count 1, enabled O)" 1 "$T/m6" "trigger: count|enabled|full definition"; }

echo "== R1 mutants: protected data and snapshot shape"
mut j_inactive m0 "update public.documentary_script_jobs set updated_at = updated_at + interval '1 second' where id = 'd0000000-0000-4000-8000-0000000003a1'" \
  && { run "$T/j1" same "$T/s_pre.snap" "$T/j_inactive.snap"; rejects "R1 inactive (completed) job changed" 1 "$T/j1" "jobs_md5 unchanged"; }
mut j_exhausted m0 "update public.documentary_script_jobs set retry_count = 3 where id = 'd0000000-0000-4000-8000-0000000003a2'" \
  && { run "$T/j2" same "$T/s_pre.snap" "$T/j_exhausted.snap"; rejects "R1 jobs_exhausted changed" 2 "$T/j2" "jobs_exhausted unchanged" "jobs_md5 unchanged"; }
mut j_pi m0 "update public.pi_paid_operations set project_id = 'p-m2'" \
  && { run "$T/j3" same "$T/s_pre.snap" "$T/j_pi.snap"; rejects "R1 protected pi_* fingerprint changed (same row count)" 1 "$T/j3" "pi_data_md5 unchanged"; }
{ cat "$T/s_pre.snap"; grep '^jobs_md5|' "$T/s_pre.snap" | sed 's/|.*/|00000000000000000000000000000000/'; } > "$T/dup.snap"
for c in pre-objects same; do if [ $c = same ]; then run "$T/j4$c" same "$T/s_pre.snap" "$T/dup.snap"; else run "$T/j4$c" $c "$T/dup.snap"; fi
  grep -q 'duplicated:.*jobs_md5' "$T/j4$c" && [ $rc != 0 ] && pass "R1 duplicated key refused by $c (exit $rc)" || fail "R1 duplicated key accepted by $c"; done
head -n 20 "$T/s_pre.snap" > "$T/trunc.snap"; run "$T/j5" same "$T/s_pre.snap" "$T/trunc.snap"; grep -q 'incomplete' "$T/j5" && [ $rc != 0 ] && pass "R1 incomplete snapshot refused by same (exit $rc)" || fail "R1 incomplete accepted"
# concurrent change after pre on the full path: forward O2, a job changes, contingency -> BLOQUEADO, diff printed, job kept
P -d postgres -c "create database conc template m0" >/dev/null; snap c_pre conc
P -d conc -f "$R/supabase/migrations/$NAME" >/dev/null 2>&1 && P -d conc -c "insert into public._migrations_applied(name) values ('$NAME')" >/dev/null
P -d conc -c "update public.documentary_script_jobs set retry_count = 3 where id = 'd0000000-0000-4000-8000-0000000003a2'" >/dev/null
bash "$O2" contingency "$(U conc)" > "$T/c.ct" 2>&1 || fail "concurrent: contingency"; snap c_after conc
run "$T/c.v" verdict "$T/c_pre.snap" "$T/c_after.snap"
[ $rc = 3 ] && grep -q 'O2 VERDICT: BLOQUEADO' "$T/c.v" && grep -q 'FAIL O2\[restored\] jobs_md5 unchanged = .* (expected ' "$T/c.v" && pass "R1 concurrent change after pre: verdict BLOQUEADO (exit 3), difference printed" || { fail "concurrent verdict rc=$rc"; cat "$T/c.v"; }
[ "$(P -d conc -At -c "select retry_count from public.documentary_script_jobs where id = 'd0000000-0000-4000-8000-0000000003a2'")" = 3 ] && pass "R1 the third-party change is kept (not restored)" || fail "concurrent job was overwritten"
cp "$T/c_after.snap" "$T/c_cls.snap"; bash "$O2" classify "$T/c_cls.snap" > "$T/c.cls" 2>&1; grep -q 'O2 STATE: PRE' "$T/c.cls" && pass "R1 after BLOQUEADO the O2 objects are PR198 again; O3 gate cannot be met (O2 not COMPLETADO)" || fail "concurrent classify"
echo "RESULT o2-mutantes: $fails FAIL"
[ $fails = 0 ]
