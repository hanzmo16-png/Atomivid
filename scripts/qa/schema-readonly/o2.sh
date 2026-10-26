#!/usr/bin/env bash
# O2 checks (migration 20261024120000_resume_authorization_ref_match.sql). READ ONLY: every query runs inside
# BEGIN TRANSACTION READ ONLY … ROLLBACK. Shared by the one-shot production workflow and the disposable-replica rehearsal,
# so the rehearsal exercises exactly these checks. Prints only counts, booleans, ACL strings and md5 digests.
#   o2.sh snap  <db-url> <out>        snapshot of everything O2 may touch (and of what it must not)
#   o2.sh pre   <snap>                the audited pre-O2 state (fails closed)
#   o2.sh post  <pre-snap> <snap>     the expected post-O2 state
#   o2.sh same  <pre-snap> <snap>     exactly the pre-O2 state again (after the contingency)
#   o2.sh probe                       read-only: timeouts of the session the tool opens. The Supabase pooler drops startup
#                                     options (PGOPTIONS), so lock_timeout stays 0; the bound is the role's statement_timeout.
# The two commands that WRITE (target = the connection resolveConnection() / the URL given; the workflow points them at
# production only after the gate and `pre` pass, the rehearsal only ever at its local replica):
#   o2.sh apply                       the plan's real tool, one file: apply-supabase-migration.ts <NAME>
#   o2.sh contingency <db-url>        audited 120000 rollback, then docs/ops/o2/O2_contingencia_registro.sql
set -uo pipefail
PSQL=${PSQL:-/usr/lib/postgresql/17/bin/psql}
NAME=20261024120000_resume_authorization_ref_match.sql
TRG='public.pi_documentary_resume_requires_budget()'; RPC='public.pi_recovery_resume_authorization(text,text)'

snap() {
  { printf 'begin transaction read only;\n'; cat <<SQL; printf 'rollback;\n'; } | "$PSQL" "$1" -X -qAt -F '|' -v ON_ERROR_STOP=1 > "$2"
select 'read_only', current_setting('transaction_read_only');
select 'ma_count', count(*) from public._migrations_applied;
select 'ma_has_o2', count(*) from public._migrations_applied where name = '$NAME';
select 'ma_md5_without_o2', md5(string_agg(name, ',' order by name)) from public._migrations_applied where name <> '$NAME';
select 'sm_md5', md5(coalesce(string_agg(version || ':' || coalesce(name, ''), ',' order by version), '')) from supabase_migrations.schema_migrations;
select 'pi_paid_operations', count(*) from public.pi_paid_operations;
select 'open_operations', count(*) from public.pi_paid_operations where status in ('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED');
select 'pi_data_md5', md5(string_agg(c.relname || ':' || (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(t::text, ''|'' order by t::text), '''')) h from public.%I t', c.relname), false, true, '')))[1]::text, ',' order by c.relname))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'pi\_%';
select 'm000', coalesce(bool_or(pg_get_functiondef(p.oid) like '%authorization missing%'), false) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'pi_submit_with_supply';
select 'm120', coalesce(bool_or(pg_get_functiondef(p.oid) like '%r.authorization_ref = b.authorization_ref%'), false) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'pi_documentary_resume_requires_budget';
select 'm130', coalesce(bool_or(pg_get_functiondef(p.oid) like '%status <> ''RESERVED''%'), false) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'pi_open_spend_authorization';
select 'm140', to_regprocedure('public.pi_supply_state_pre_studio(text)') is not null;
select 'studio_tables', to_regclass('public.podcast_studio_episodes') is not null or to_regclass('public.podcast_studio_operations') is not null;
select 'trg_def_md5', md5(pg_get_functiondef('$TRG'::regprocedure));
select 'trg_secdef', prosecdef from pg_proc where oid = '$TRG'::regprocedure;
select 'trg_config', coalesce(array_to_string(proconfig, ','), '') from pg_proc where oid = '$TRG'::regprocedure;
select 'trg_owner', pg_get_userbyid(proowner) from pg_proc where oid = '$TRG'::regprocedure;
select 'trg_acl', coalesce(proacl::text, 'NULL') from pg_proc where oid = '$TRG'::regprocedure;
select 'rpc_def_md5', md5(pg_get_functiondef('$RPC'::regprocedure));
select 'rpc_secdef', prosecdef from pg_proc where oid = '$RPC'::regprocedure;
select 'rpc_config', coalesce(array_to_string(proconfig, ','), '') from pg_proc where oid = '$RPC'::regprocedure;
select 'rpc_owner', pg_get_userbyid(proowner) from pg_proc where oid = '$RPC'::regprocedure;
select 'rpc_acl', coalesce(proacl::text, 'NULL') from pg_proc where oid = '$RPC'::regprocedure;
select 'exec_' || r || '_' || f, has_function_privilege(r, f::regprocedure, 'EXECUTE')
  from unnest(array['anon','authenticated','service_role']) r, unnest(array['$TRG','$RPC']) f order by 1;
select 'trigger', count(*) || ':' || coalesce(string_agg(tgenabled::text || ':' || md5(pg_get_triggerdef(oid)), ','), '') from pg_trigger
  where not tgisinternal and tgname = 'pi_documentary_resume_requires_budget' and tgrelid = 'public.documentary_script_jobs'::regclass;
select 'other_functions_md5', md5(string_agg(p.oid::regprocedure::text || '=' || md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind in ('f','p')
  and p.oid not in ('$TRG'::regprocedure, '$RPC'::regprocedure);
select 'other_triggers_md5', md5(coalesce(string_agg(tgrelid::regclass::text || '.' || tgname || ':' || tgenabled::text || ':' || md5(pg_get_triggerdef(oid)), ',' order by 1), ''))
  from pg_trigger where not tgisinternal and tgname <> 'pi_documentary_resume_requires_budget';
select 'tables_md5', md5(string_agg(c.relname || ':' || c.relkind || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity, ',' order by c.relname))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v','m','p');
select 'acl_' || t, coalesce(c.relacl::text, 'NULL') from unnest(array['pi_recovery_resume_authorizations','pi_recovery_budgets','documentary_script_jobs']) t
  join pg_class c on c.oid = to_regclass('public.' || t) order by 1;
select 'jobs_active', count(*) from public.documentary_script_jobs where status in ('queued','running');
select 'jobs_exhausted', count(*) from public.documentary_script_jobs where status = 'failed' and retry_count >= 3;
select 'jobs_md5', md5(coalesce(string_agg(id::text || ':' || status || ':' || retry_count, ',' order by id), '')) from public.documentary_script_jobs;
select 'other_locks_on_jobs', count(*) from pg_locks l where l.relation = 'public.documentary_script_jobs'::regclass and l.pid <> pg_backend_pid();
select 'long_xacts', count(*) from pg_stat_activity where pid <> pg_backend_pid() and xact_start < now() - interval '60 seconds' and state <> 'idle';
SQL
}

get() { awk -F'|' -v k="$2" '$1 == k { sub(/^[^|]*[|]/, ""); print; exit }' "$1"; }
fails=0
chk() { if [ "$2" = "$3" ]; then echo "PASS O2[$1] $4 = $2"; else echo "FAIL O2[$1] $4 = $2 (expected $3)"; fails=$((fails+1)); fi; }
same_as() { chk "$1" "$(get "$3" "$4")" "$(get "$2" "$4")" "$4 unchanged"; }

R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
MIG=$R/supabase/migrations/$NAME; RB=$R/supabase/proposals/${NAME%.sql}.rollback.sql; CT=$R/docs/ops/o2/O2_contingencia_registro.sql
SHA_MIG=13dffaa6ec3639a4348f6005d8f590549af3b24a930b967e452894a3f44e9fbf; SHA_RB=89d82016f005de253d76e27bdcb0a176fdf3ea759316cb538f2789a024fa7d41
SHA_CT=2c1eaee82303d62d3faafcfcb1dd14033fa848f40600f1ab5697d0548e3b7dbe
hashes() { [ "$(sha256sum < "$MIG" | cut -d' ' -f1)" = $SHA_MIG ] && cmp -s "$MIG" "$R/supabase/proposals/$NAME" && [ "$(sha256sum < "$RB" | cut -d' ' -f1)" = $SHA_RB ] \
  && [ "$(sha256sum < "$CT" | cut -d' ' -f1)" = $SHA_CT ] || { echo "FAIL O2 sha256 of the migration / rollback / contingency differs from the audited one"; exit 1; }; }
TRG_ACL_PRE='{postgres=X/postgres,service_role=X/postgres}'
RPC_ACL='{postgres=X/postgres,service_role=X/postgres}'

case "${1:-}" in
  snap) snap "$2" "$3" || { echo "FAIL O2[snap] read-only snapshot query failed"; exit 1; }; [ "$(get "$3" read_only)" = on ] || { echo "FAIL O2[snap] not read-only"; exit 1; }; echo "snapshot: $(wc -l < "$3") facts";;
  pre)
    s=$2
    chk pre "$(get $s ma_count)" 63 "_migrations_applied rows"; chk pre "$(get $s ma_has_o2)" 0 "$NAME registered"
    chk pre "$(get $s pi_paid_operations)" 548 "pi_paid_operations rows"; chk pre "$(get $s open_operations)" 41 "open pi_paid_operations"
    chk pre "$(get $s m000)$(get $s m120)$(get $s m130)$(get $s m140)" tfff "markers 000000/120000/130000/140000"
    chk pre "$(get $s studio_tables)" f "studio tables present"
    chk pre "$(get $s trg_secdef)|$(get $s trg_config)|$(get $s trg_owner)" 'f|search_path=""|postgres' "trigger fn secdef|config|owner (PR198 body)"
    chk pre "$(get $s trg_acl)" "$TRG_ACL_PRE" "trigger fn ACL (restored by the contingency)"
    chk pre "$(get $s rpc_secdef)|$(get $s rpc_config)|$(get $s rpc_owner)|$(get $s rpc_acl)" "t|search_path=\"\"|postgres|$RPC_ACL" "RPC secdef|config|owner|ACL"
    chk pre "$(get $s exec_anon_$TRG)$(get $s exec_authenticated_$TRG)$(get $s exec_anon_$RPC)$(get $s exec_authenticated_$RPC)" ffff "anon/authenticated EXECUTE on both functions"
    chk pre "$(get $s trigger | cut -d: -f1-2)" 1:O "trigger installed once and enabled"
    chk pre "$(get $s jobs_active)" 0 "documentary jobs queued/running (nothing in flight while the trigger is replaced)"
    chk pre "$(get $s other_locks_on_jobs)" 0 "other sessions holding locks on documentary_script_jobs"
    chk pre "$(get $s long_xacts)" 0 "non-idle transactions open for more than 60 s"
    echo "INFO pre: exhausted documentary jobs=$(get $s jobs_exhausted)";;
  post)
    p=$2; s=$3
    chk post "$(get $s ma_count)" 64 "_migrations_applied rows (63 + 1)"; chk post "$(get $s ma_has_o2)" 1 "$NAME registered"
    same_as post $p $s ma_md5_without_o2; same_as post $p $s sm_md5
    chk post "$(get $s pi_paid_operations)" 548 "pi_paid_operations rows"; chk post "$(get $s open_operations)" "$(get $p open_operations)" "open pi_paid_operations"
    chk post "$(get $s m000)$(get $s m120)$(get $s m130)$(get $s m140)" ttff "markers 000000/120000/130000/140000"
    chk post "$(get $s studio_tables)" f "studio tables present"
    chk post "$(get $s trg_secdef)|$(get $s trg_config)|$(get $s trg_owner)|$(get $s trg_acl)" 't|search_path=""|postgres|{postgres=X/postgres}' "trigger fn secdef|config|owner|ACL"
    chk post "$(get $s rpc_secdef)|$(get $s rpc_config)|$(get $s rpc_owner)|$(get $s rpc_acl)" "t|search_path=\"\"|postgres|$RPC_ACL" "RPC secdef|config|owner|ACL"
    chk post "$(get $s exec_anon_$TRG)$(get $s exec_authenticated_$TRG)$(get $s exec_service_role_$TRG)$(get $s exec_anon_$RPC)$(get $s exec_authenticated_$RPC)$(get $s exec_service_role_$RPC)" ffffft "EXECUTE anon/auth/service_role trigger fn, then RPC"
    chk post "$(get $s trigger | cut -d: -f1-2)" 1:O "trigger installed once and enabled"
    same_as post $p $s pi_data_md5; same_as post $p $s other_functions_md5; same_as post $p $s other_triggers_md5; same_as post $p $s tables_md5
    chk post "$(get $s jobs_active)" 0 "documentary jobs queued/running (no requeue happened)"
    same_as post $p $s jobs_md5;;
  same)
    p=$2; s=$3
    for k in ma_count ma_has_o2 ma_md5_without_o2 sm_md5 pi_paid_operations open_operations pi_data_md5 m000 m120 m130 m140 studio_tables \
             trg_def_md5 trg_secdef trg_config trg_owner trg_acl rpc_def_md5 rpc_secdef rpc_config rpc_owner rpc_acl trigger \
             other_functions_md5 other_triggers_md5 tables_md5 jobs_active; do same_as restored $p $s $k; done
    for r in anon authenticated service_role; do for f in "$TRG" "$RPC"; do same_as restored $p $s "exec_${r}_$f"; done; done;;
  probe)
    out=$(cd "$R" && npx tsx -e 'import { connectResolved } from "./scripts/lib/supabase-db"; (async () => { const { client } = await connectResolved(); const r = await client.query("begin transaction read only; show lock_timeout; show statement_timeout; show transaction_read_only; rollback;"); console.log((r as any).filter((x: any) => x.rows?.length).map((x: any) => Object.values(x.rows[0])[0]).join(",")); await client.end(); })().catch((e) => { console.error(e.message); process.exit(1); })' 2>&1 | tail -1)
    echo "INFO probe: lock_timeout,statement_timeout,transaction_read_only on the tool's own connection = $out"
    chk probe "$(echo "$out" | cut -d, -f2-)" "${EXPECT_STATEMENT_TIMEOUT:-2min},on" "statement_timeout (bounds any lock wait of the migration),read-only probe";;
  apply)
    hashes; echo "apply (no lock_timeout through the pooler; bound = statement_timeout): sha256 migration $SHA_MIG (== proposal), rollback $SHA_RB, contingency $SHA_CT"
    (cd "$R" && timeout 300 npx tsx scripts/apply-supabase-migration.ts "$NAME") 2>&1 | tee "${OUT:-.}/o2-apply.log"; rc=${PIPESTATUS[0]}
    chk apply "$rc" 0 "apply-supabase-migration.ts exit code"
    chk apply "$(grep -c "Resumen: 1 aplicada(s) \[$NAME\], 0 reconciliada(s)" "${OUT:-.}/o2-apply.log")" 1 "tool summary: exactly 1 applied ($NAME), 0 reconciled";;
  contingency)
    hashes; echo "contingency: step 1 rollback $SHA_RB, step 2 $SHA_CT"
    "$PSQL" "$2" -X -v ON_ERROR_STOP=1 -f "$RB"; chk contingency $? 0 "step 1: audited 120000 rollback (restores the PR198 bodies)"
    "$PSQL" "$2" -X -v ON_ERROR_STOP=1 -f "$CT"; chk contingency $? 0 "step 2: re-grant service_role on the trigger fn + remove the registry row";;
  *) echo "usage: o2.sh snap|pre|post|same …"; exit 2;;
esac
echo "RESULT o2 ${1}: $fails FAIL"
[ $fails = 0 ]
