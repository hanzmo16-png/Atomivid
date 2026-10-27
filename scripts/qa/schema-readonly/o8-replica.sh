#!/usr/bin/env bash
# O8 rehearsal on a DISPOSABLE PostgreSQL 17 (USD 0). PRODUCTION IS ONLY READ: o3.sh `pre` (current state), o8.sh snapshot
# (supply functions and access as they are now), the tool-connection probe and run evidence on GitHub (read-only), then
# pg_dump with default_transaction_read_only=on. Every write goes to the local replica (unix socket, port 55997): O3 is
# applied there first with o3.sh apply (O8 requires O3), then O8 with o8.sh apply, with every production credential
# removed from the tool's environment. The O8 gate (tree == #207 after O7) cannot hold before O7: it is covered offline by
# gate_test.py, and stated as such below.
# Harness discipline (harness-lib.sh): any unexpected harness error ends in a non-zero exit and a failed RESULT;
# expect_reject demands the real exit code, the exact FAIL count, the RESULT line and every reason.
R=$(git rev-parse --show-toplevel); T=$(mktemp -d); PGBIN=/usr/lib/postgresql/17/bin
O3="$R/scripts/qa/schema-readonly/o3.sh"; O8="$R/scripts/qa/schema-readonly/o8.sh"
H_NAME=o8-replica; . "$R/scripts/qa/schema-readonly/harness-lib.sh"; export OUT=$T
NAME=20261024140000_podcast_v3_studio.sql

echo "== 1. Production, READ ONLY: current state, supply functions, run evidence, probe, dumps"
PROD=$(cd "$R" && npx tsx -e 'import { resolveConnection } from "./scripts/lib/supabase-db"; const c = resolveConnection(); if (!c) { process.exit(3) } process.stdout.write(c.connectionString)') || { echo "FAIL no DB credential"; exit 1; }
PW=$(node -e 'const u=new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.password))' "$PROD"); echo "::add-mask::$PW"; echo "::add-mask::$PROD"
bash "$O3" snap "$PROD" "$T/prod-o3.snap" > "$T/prod-o3.log" 2>&1 || { cat "$T/prod-o3.log"; echo "FAIL production o3 snapshot"; exit 1; }
expect_ok "production right now: o3.sh pre (O3 not yet applied; O8 follows O3 → O7)" "$T/prod-o3.pre" -- bash "$O3" pre "$T/prod-o3.snap"
bash "$O8" snap "$PROD" "$T/prod.snap" > "$T/prod.snaplog" 2>&1 || { cat "$T/prod.snaplog"; echo "FAIL production o8 snapshot"; exit 1; }
pass "production: o8.sh snapshot complete in a READ ONLY transaction (pi_supply_state / pi_supply_spend evaluated read-only)"
expect_reject "production is not yet in the O8 pre-state (130000 not registered, marker 130000 f)" 2 1 "$T/prod-o8.pre" "130000 registered | 140000 not registered" "markers 000000/120000/130000/140000" -- bash "$O8" pre "$T/prod.snap"
bash "$O8" o3run 40427566003 > "$T/o3run-neg.out" 2>&1; grep -q '^FAIL O8\[o3run\]' "$T/o3run-neg.out" && pass "negative: the O2 run is refused as O3 evidence (O3 has not run yet; the real run id is an input of the O8 workflow)" || fail "o3run accepted a foreign run"
expect_ok "production: tool connection statement_timeout=2min, read-only probe" "$T/probe.out" -- bash "$O8" probe
export PGOPTIONS="-c default_transaction_read_only=on"
"$PGBIN/pg_dump" "$PROD" --schema-only --no-owner --no-comments -n public -f "$T/public.sql" 2>/dev/null || { echo "FAIL pg_dump schema"; exit 1; }
"$PGBIN/pg_dump" "$PROD" --data-only --disable-triggers --no-owner -t 'public.pi_*' -t public._migrations_applied -t public.video_requests -t public.podcast_episodes -f "$T/data.sql" 2>/dev/null || { echo "FAIL pg_dump data"; exit 1; }
"$PGBIN/pg_dump" "$PROD" --no-owner --no-privileges -n supabase_migrations -f "$T/sm.sql" 2>/dev/null || { echo "FAIL pg_dump registry"; exit 1; }
unset PGOPTIONS PROD PW

echo "== 2. Disposable replica (production now) + O3 applied on it (the state O8 starts from)"
L=$T/local; "$PGBIN/initdb" -D "$L" -U postgres --auth=trust >/dev/null; "$PGBIN/pg_ctl" -D "$L" -o "-p 55997 -k $T -c listen_addresses=''" -l "$T/pg.log" -w start >/dev/null
H_CLEANUP='"$PGBIN/pg_ctl" -D "$L" -m fast stop >/dev/null 2>&1 || true; rm -rf "$T/public.sql" "$T/data.sql" "$T/sm.sql"'
LW(){ "$PGBIN/psql" -h "$T" -p 55997 -U postgres -X -q "$@"; }   # the ONLY direct write path: local socket
LW -d postgres -c "create database replica" >/dev/null
LW -d replica -f "$R/scripts/harness/e2e/infra/stubs.sql" >/dev/null 2>&1
LW -d replica -c "create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create extension if not exists \"uuid-ossp\" with schema extensions" >/dev/null 2>&1
LW -d replica -f "$T/public.sql" >/dev/null 2>&1; LW -d replica -f "$T/sm.sql" >/dev/null 2>&1; LW -d replica -f "$T/data.sql" >/dev/null 2>&1
U(){ echo "postgresql://postgres@localhost/${1:-replica}?host=$T&port=55997"; }
q(){ LW -d "${2:-replica}" -At -c "$1"; }
[ "$(q 'show port')" = 55997 ] && [ -z "$(q 'select inet_server_port()')" ] && pass "write target is the local socket replica (port 55997, no TCP)" || { fail "write target is not the local replica"; exit 1; }
TOOLENV=(env -u SUPABASE_DB_PASSWORD -u SUPABASE_PROJECT_REF -u SUPABASE_URL -u SUPABASE_DB_HOST -u SUPABASE_DB_PORT SUPABASE_DB_URL="$(U)")
o3(){ "${TOOLENV[@]}" bash "$O3" "$@"; }
o8(){ "${TOOLENV[@]}" bash "$O8" "$@"; }
snap(){ bash "$O8" snap "$(U "${2:-replica}")" "$T/$1.tmp" > "$T/$1.snaplog" 2>&1 && mv "$T/$1.tmp" "$T/$1.snap" || { fail "snapshot $1 failed or incomplete: $(grep -E 'FAIL|ERROR' "$T/$1.snaplog" | head -2)"; echo "aborted: no check may run on a broken snapshot"; exit 1; }; }
cls(){ o8 classify "$1" 2>&1 || true; }
# production's ACLs (the local stubs grant anon/authenticated by default) and the platform's default privileges for NEW
# objects (Supabase grants functions/tables in public to anon, authenticated, service_role), so 140000's revokes are tested
LW -d replica -c "revoke all on function public.pi_open_spend_authorization(uuid,numeric,text) from public, anon, authenticated; grant execute on function public.pi_open_spend_authorization(uuid,numeric,text) to service_role;
  revoke all on function public.pi_supply_state(text), public.pi_supply_spend(text,timestamptz) from public, anon, authenticated; grant execute on function public.pi_supply_state(text), public.pi_supply_spend(text,timestamptz) to service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role" >/dev/null
LW -d replica -c "alter role postgres set statement_timeout = '2min'" >/dev/null
bash "$O8" snap "$(U)" "$T/r00.snap" > /dev/null 2>&1 || { fail "replica pre-O3 o8 snapshot"; exit 1; }
same=1; for k in fn_spend fn_state fn_prestate fn_counts fn_cap exec_spend exec_state studio_tables m000 m120 m130 m140 ma_count supply_md5 spend_md5 auth_rows auth_md5; do
  [ "$(grep "^$k|" "$T/r00.snap")" = "$(grep "^$k|" "$T/prod.snap")" ] || { same=0; fail "replica differs from production in $k"; }; done
[ $same = 1 ] && pass "replica == production in supply function bodies/attributes/EXECUTE, 140000 objects, markers, registry count, supply state and spend, authorizations"
o3 apply > "$T/o3apply.log" 2>&1 && pass "O3 applied on the replica (o3.sh apply)" || { fail "O3 apply on the replica"; tail -5 "$T/o3apply.log"; }
bash "$O3" snap "$(U)" "$T/o3done.snap" > /dev/null 2>&1; expect_ok "replica after O3: o3.sh done (what step 2 of the O8 workflow requires)" "$T/o3done.out" -- bash "$O3" done "$T/o3done.snap"
snap r0; expect_ok "replica meets the O8 preconditions" "$T/r0.pre" -- o8 pre "$T/r0.snap"
grep -q 'O8 STATE: PRE' <(cls "$T/r0.snap") && pass "classify pre-O8 = PRE" || fail "classify pre"

# effective access by role, inside transactions that are always rolled back; studio tables only exist after O8
FN_LIST="public.pi_supply_state('elevenlabs')|public.pi_supply_spend('elevenlabs', now())"
call(){ LW -d "$1" -At -v ON_ERROR_STOP=1 2>&1 <<SQL || true
begin;
set local role $2;
select 'R ' || ($3)::text;
rollback;
SQL
}
access(){ local label=$1 db=${2:-replica} ok=1 f r o before after
  before=$(q "select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.pi_paid_operations t" "$db")
  IFS='|' read -ra FS <<< "$FN_LIST"
  [ "$(q "select to_regprocedure('public.pi_studio_call_counts(text,timestamptz,text)') is not null" "$db")" = t ] && FS+=("public.pi_studio_call_counts('elevenlabs', now(), null)")
  for f in "${FS[@]}"; do
    for r in anon authenticated; do o=$(call "$db" $r "$f"); printf '%s\n' "$o" | grep -q 'permission denied for function' || { ok=0; echo "INFO $label · $r · $f: $(printf '%s' "$o" | head -1)"; }; done
    o=$(call "$db" service_role "$f"); printf '%s\n' "$o" | grep -q '^R ' || { ok=0; echo "INFO $label · service_role · $f: $(printf '%s' "$o" | head -1)"; }
  done
  [ $ok = 1 ] && pass "$label: anon/authenticated refused by PostgreSQL on every supply/studio function, service_role executes (${#FS[@]} functions)" || fail "$label: effective function access by role"
  if [ "$(q "select to_regclass('public.podcast_studio_operations') is not null" "$db")" = t ]; then ok=1
    for r in anon authenticated; do for t in podcast_studio_episodes podcast_studio_operations; do
      o=$(LW -d "$db" -At -v ON_ERROR_STOP=1 2>&1 <<SQL || true
begin; set local role $r; delete from public.$t; rollback;
SQL
); printf '%s\n' "$o" | grep -q "permission denied for table $t" || { ok=0; echo "INFO $label · $r delete $t: $(printf '%s' "$o" | head -1)"; }
      o=$(LW -d "$db" -At -v ON_ERROR_STOP=1 2>&1 <<SQL || true
begin; set local role $r; select 'N ' || count(*) from public.$t; rollback;
SQL
); [ "$(printf '%s\n' "$o" | grep '^N ')" = "N 0" ] || printf '%s\n' "$o" | grep -q 'permission denied' || { ok=0; echo "INFO $label · $r select $t: $o"; }
    done; done
    [ $ok = 1 ] && pass "$label: anon/authenticated cannot write either studio table (permission denied) and read nothing through RLS" || fail "$label: studio table access by role"
  fi
  after=$(q "select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.pi_paid_operations t" "$db")
  [ -n "$before" ] && [ "$before" = "$after" ] && pass "$label: no persistent effect (ledger fingerprint unchanged)" || fail "$label: the access probe changed data"; }
access "access before O8"

echo "== 3. O8 on the replica exactly as the workflow runs it"
o8 apply > "$T/apply1.log" 2>&1 && pass "o8.sh apply: exit 0, exactly 1 applied (SQL + registry in one transaction), 0 reconciled" || { fail "o8.sh apply"; tail -5 "$T/apply1.log"; }
snap r1
expect_ok "o8.sh post: every post-O8 check passes" "$T/r1.post" -- o8 post "$T/r0.snap" "$T/r1.snap"
expect_ok "o8.sh done on the post-O8 state" "$T/r1.done" -- o8 done "$T/r1.snap"
grep -q 'O8 STATE: COMPLETADO' <(cls "$T/r1.snap") && pass "classify post-O8 = COMPLETADO" || fail "classify post"
access "access after O8"
# behaviour: the cap trigger refuses a reservation above the authorized amount (rolled back; nothing persists)
o=$(LW -d replica -At -v ON_ERROR_STOP=1 2>&1 <<'SQL' || true
begin;
insert into auth.users(id, email) values ('cccccccc-0000-4000-8000-0000000008e1', 'o8@x') on conflict do nothing;
insert into public.podcast_studio_episodes(id, user_id, title, mode, spec, status, authorized_usd) values ('e0000000-0000-4000-8000-0000000008a1', 'cccccccc-0000-4000-8000-0000000008e1', 'o8 probe', 'narracion', '{}', 'authorized', 1);
insert into public.podcast_studio_operations(key, user_id, episode_id, provider, op, state, reserved_usd) values ('o8-probe-1', 'cccccccc-0000-4000-8000-0000000008e1', 'e0000000-0000-4000-8000-0000000008a1', 'elevenlabs', 'tts', 'reserved', 5);
rollback;
SQL
); printf '%s\n' "$o" | grep -q 'STUDIO_CAP' && pass "cap trigger: a USD 5 reservation on a USD 1 authorization is refused by the database (STUDIO_CAP)" || fail "cap trigger did not refuse: $(printf '%s' "$o" | tail -2)"
[ "$(q "select count(*) from public.podcast_studio_episodes")" = 0 ] && pass "cap probe rolled back (studio ledger still empty)" || fail "cap probe persisted"
expect_reject "N1 second run on the post-O8 state stops at 'pre'" 5 1 "$T/n1.out" "130000 registered | 140000 not registered" "markers 000000/120000/130000/140000" "pi_supply_spend body (prosrc md5 == 20261005150229)" "pi_supply_state body (== 20261005150229)" "140000 objects absent" -- o8 pre "$T/r1.snap"
o8 apply > "$T/apply2.log" 2>&1; grep -q 'ya está registrada como aplicada' "$T/apply2.log" && grep -q 'Resumen: 0 aplicada' "$T/apply2.log" && pass "re-running the tool: skipped, 0 applied" || fail "tool re-run"
snap r1b; cmp -s <(grep -v '^read_only' "$T/r1.snap") <(grep -v '^read_only' "$T/r1b.snap") && pass "re-run changed nothing (complete snapshots identical)" || fail "re-run changed state"

echo "== 4. Contingency"
LW -d postgres -c "create database onlyrb template replica" >/dev/null
"$PGBIN/psql" "$(U onlyrb)" -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$R/supabase/proposals/${NAME%.sql}.rollback.sql" >/dev/null 2>&1; snap rb onlyrb
expect_reject "N4 audited rollback ALONE leaves the registry row" 2 1 "$T/rb.same" "ma_count unchanged" "ma_has_o8 unchanged" -- bash "$O8" same "$T/r0.snap" "$T/rb.snap"
"$PGBIN/psql" "$(U)" -X -q -v ON_ERROR_STOP=1 -f "$R/docs/ops/o8/O8_contingencia_registro.sql" > /dev/null 2> "$T/ct0.err"; rc=$?; snap n2
[ $rc != 0 ] && grep -q 'O8 CONTINGENCIA: precondition failed' "$T/ct0.err" && cmp -s <(grep -v '^read_only' "$T/r1.snap") <(grep -v '^read_only' "$T/n2.snap") && pass "N2 step 2 before step 1: refused, state byte-identical" || fail "N2 (rc=$rc)"
# guard: with a studio row the contingency refuses and drops nothing
LW -d postgres -c "create database guarded template replica" >/dev/null
LW -d guarded -c "insert into auth.users(id, email) values ('cccccccc-0000-4000-8000-0000000008e2', 'o8g@x') on conflict do nothing; insert into public.podcast_studio_episodes(user_id, title, mode, spec, status) values ('cccccccc-0000-4000-8000-0000000008e2', 'kept', 'narracion', '{}', 'draft')" >/dev/null
expect_reject "G1 contingency with a studio episode: refused at step 1 (guard), step 2 not run" 2 1 "$T/g1.out" "step 1: guard (140000 present, 0 studio rows)" "step 1 failed: STOP, step 2 NOT run" -- bash "$O8" contingency "$(U guarded)"
[ "$(q "select title from public.podcast_studio_episodes" guarded)" = kept ] && [ "$(q "select to_regprocedure('public.pi_supply_state_pre_studio(text)') is not null" guarded)" = t ] && pass "G1 nothing dropped: the studio row and every 140000 object are intact" || fail "G1 guard dropped something"
expect_ok "o8.sh contingency: both steps exit 0" "$T/ct1.log" -- o8 contingency "$(U)"
snap r2; expect_ok "after the contingency the replica is EXACTLY the pre-O8 state" "$T/r2.same" -- o8 same "$T/r0.snap" "$T/r2.snap"
o8 verdict "$T/r0.snap" "$T/r2.snap" > "$T/v2.out"; [ $? = 0 ] && pass "verdict = REVERTIDO" || { fail "verdict clean"; cat "$T/v2.out"; }
bash "$O3" snap "$(U)" "$T/o3after.snap" > /dev/null 2>&1; expect_ok "after the contingency O3 is still exactly done (O8's contingency does not touch O3)" "$T/o3after.out" -- bash "$O3" done "$T/o3after.snap"
access "access after the contingency (permissions restored)"
# the audited rollback is NOT idempotent (on a pre-O8 state it would drop pi_supply_state): the guard must refuse
expect_reject "G2 contingency on the pre-O8 state: refused at step 1 (would drop pi_supply_state)" 2 1 "$T/g2.out" "step 1: guard (140000 present, 0 studio rows)" "step 1 failed: STOP, step 2 NOT run" -- o8 contingency "$(U)"
snap r2b; expect_ok "G2 nothing changed: pi_supply_state intact, exact pre-O8 state" "$T/r2b.same" -- o8 same "$T/r0.snap" "$T/r2b.snap"
LW -d postgres -c "create database rbraw template replica" >/dev/null; "$PGBIN/psql" "$(U rbraw)" -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$R/supabase/proposals/${NAME%.sql}.rollback.sql" >/dev/null 2>&1
[ "$(q "select to_regprocedure('public.pi_supply_state(text)') is null" rbraw)" = t ] && pass "G2 why: the raw rollback on a pre-O8 state really drops pi_supply_state (the guard is needed)" || fail "G2 premise: raw rollback did not drop pi_supply_state"

echo "== 5. Fault injection and regressions"
# applied without registry (cannot happen with the tool, which is atomic here; checked anyway)
LW -d postgres -c "create database noreg template replica" >/dev/null; "$PGBIN/psql" "$(U noreg)" -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$R/supabase/migrations/$NAME" >/dev/null 2>&1; snap n3 noreg
grep -q 'O8 STATE: PARCIAL_SIN_REGISTRO' <(cls "$T/n3.snap") && pass "N3 SQL without registry = PARCIAL_SIN_REGISTRO" || fail "N3 classify"
expect_ok "N3 recovery: contingency from SQL-without-registry exits 0" "$T/n3.ct" -- o8 contingency "$(U noreg)"
snap n3b noreg; expect_ok "N3 recovery restores exactly the pre-O8 state" "$T/n3b.same" -- o8 same "$T/r0.snap" "$T/n3b.snap"
access "access after recovering from SQL without registry" noreg
LW -d postgres -c "create database regonly template replica" >/dev/null; LW -d regonly -c "insert into public._migrations_applied(name) values ('$NAME')" >/dev/null; snap n7 regonly
grep -q 'O8 STATE: PARCIAL_SOLO_REGISTRO' <(cls "$T/n7.snap") && pass "N7 registry row without SQL = PARCIAL_SOLO_REGISTRO" || fail "N7"
LW -d postgres -c "create database tamper template replica" >/dev/null
sed 's/studioTodayCalls/studioTodayCallz/' "$R/supabase/migrations/$NAME" > "$T/tampered.sql"
"$PGBIN/psql" "$(U tamper)" -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$T/tampered.sql" -c "insert into public._migrations_applied(name) values ('$NAME')" >/dev/null 2>&1; snap n6 tamper
expect_reject "N6 tampered wrapper body (marker 140000 still t): done" 1 1 "$T/n6.out" "pi_supply_state wrapper body (== 140000)" -- o8 done "$T/n6.snap"
grep -q 'INDETERMINADO' <(cls "$T/n6.snap") && pass "N6 classify = INDETERMINADO" || fail "N6 classify"
head -n 12 "$T/r0.snap" > "$T/trunc.snap"
expect_reject "N5 truncated snapshot refused by pre" 1 1 "$T/n5.out" "snapshot $T/trunc.snap incomplete" -- o8 pre "$T/trunc.snap"
{ cat "$T/r0.snap"; echo "spend_md5|00"; } > "$T/dup.snap"
expect_reject "N5 duplicated key refused by same" 1 1 "$T/n5b.out" "duplicated:spend_md5" -- o8 same "$T/r0.snap" "$T/dup.snap"
# concurrent change of protected data between pre and post -> post fails on it; contingency -> BLOQUEADO, data kept
snap n8pre
LW -d replica -c "insert into auth.users(id, email) values ('cccccccc-0000-4000-8000-0000000008e4', 'o8c@x') on conflict do nothing; insert into public.podcast_episodes(id, user_id, title, source) values ('e0000000-0000-4000-8000-0000000008b0', 'cccccccc-0000-4000-8000-0000000008e4', 'concurrente', 'upload')" >/dev/null
o8 apply > "$T/n8.apply" 2>&1 || fail "N8 setup: apply"; snap n8post
expect_reject "N8 concurrent podcast change between pre and post: post" 1 1 "$T/n8.out" "podcast_md5 unchanged" -- o8 post "$T/n8pre.snap" "$T/n8post.snap"
o8 contingency "$(U)" > "$T/n8.ct" 2>&1 || fail "N8 contingency"; snap n8after; o8 verdict "$T/n8pre.snap" "$T/n8after.snap" > "$T/v8.out"; rc=$?
[ $rc = 3 ] && grep -q 'BLOQUEADO' "$T/v8.out" && [ "$(grep -c '^FAIL' "$T/v8.out")" = 1 ] && pass "N8 verdict = BLOQUEADO (exit 3), only the concurrent row differs" || { fail "N8 verdict rc=$rc"; cat "$T/v8.out"; }
[ "$(q "select title from public.podcast_episodes where id = 'e0000000-0000-4000-8000-0000000008b0'")" = concurrente ] && pass "N8 the concurrent row is untouched" || fail "N8 row modified"
LW -d replica -c "delete from public.podcast_episodes where id = 'e0000000-0000-4000-8000-0000000008b0'" >/dev/null; snap n8c; expect_ok "N8 cleanup: exact pre-O8 state" "$T/n8c.same" -- o8 same "$T/r0.snap" "$T/n8c.snap"
# contingency step 1 fails (another session holds a studio table lock past statement_timeout): step 2 must not run
o8 apply > /dev/null 2>&1 || fail "N9 setup"
LW -d replica -c "alter role postgres set statement_timeout = '6s'" >/dev/null
( PGOPTIONS="-c statement_timeout=0" LW -d replica -c "begin; lock table public.podcast_studio_operations in access share mode; select pg_sleep(20); rollback;" >/dev/null 2>&1 ) & H=$!; sleep 1
o8 contingency "$(U)" > "$T/ct9.log" 2>&1; rc=$?; kill $H 2>/dev/null; wait $H 2>/dev/null; LW -d replica -c "alter role postgres set statement_timeout = '2min'" >/dev/null; snap n9
[ $rc != 0 ] && grep -q 'step 1 failed: STOP, step 2 NOT run' "$T/ct9.log" && ! grep -q 'step 2:' "$T/ct9.log" && [ "$(grep '^ma_has_o8|' "$T/n9.snap" | cut -d'|' -f2)" = 1 ] && pass "N9 step 1 failed: contingency stopped, step 2 not run" || { fail "N9 rc=$rc"; tail -4 "$T/ct9.log"; }
grep -q 'O8 STATE: COMPLETADO' <(cls "$T/n9.snap") && pass "N9 classify = COMPLETADO (the one-transaction rollback rolled back as a whole)" || fail "N9 classify"
expect_ok "N9 recovery: contingency re-run after the failed step 1 exits 0" "$T/n9.ct2" -- o8 contingency "$(U)"
snap n9b; expect_ok "N9 recovery restores exactly the pre-O8 state" "$T/n9b.same" -- o8 same "$T/r0.snap" "$T/n9b.snap"
access "access after recovering from a failed contingency step 1"
# binding
o8 bind 0000000000000000000000000000000000000000 > "$T/n10.out"; grep -q '^FAIL O8\[bind\] checked-out commit' "$T/n10.out" && pass "N10 bind refuses a different SHA" || fail "N10"
o8 bind "$(git -C "$R" rev-parse HEAD)" > /dev/null && pass "positive: bind accepts the checked-out SHA" || fail "bind positive"
# the O8 gate: offline (stage O8 13 checks, DONE 13 checks, and its negatives) — it cannot hold on a replica before O7
python3 -I "$R/scripts/qa/schema-readonly/gate_test.py" > "$T/gate_test.out" 2>&1 && pass "gate_test.py (stages O8/DONE and their fail-closed cases) passes offline" || { fail "gate_test.py"; tail -5 "$T/gate_test.out"; }

echo "== 6. Repeatability"
o8 apply > /dev/null 2>&1 && snap r6 && o8 post "$T/r0.snap" "$T/r6.snap" > /dev/null && pass "forward path repeatable after the contingency" || fail "forward not repeatable"
d=$(diff <(grep -vE '^(read_only|supply_md5|spend_md5)\|' "$T/r1.snap") <(grep -vE '^(read_only|supply_md5|spend_md5)\|' "$T/r6.snap") | grep -c '^<'); [ "$d" = 0 ] && pass "second forward identical to the first (every object fact)" || fail "second forward differs in $d facts"
h_finish
