#!/usr/bin/env bash
# O2 checks (migration 20261024120000_resume_authorization_ref_match.sql). READ ONLY: every query runs inside
# BEGIN TRANSACTION READ ONLY … ROLLBACK. Shared by the one-shot production workflow and the disposable-replica rehearsal,
# so the rehearsal exercises exactly these checks. Prints only counts, booleans, ACL strings, definitions and md5 digests.
#   o2.sh snap     <db-url> <out>     snapshot of everything O2 may touch (and of what it must not); fails if incomplete
#   o2.sh pre      <snap>             the audited pre-O2 state (fails closed)
#   o2.sh done     <snap>             the audited post-O2 state, absolute (no pre needed): what O3 must require
#   o2.sh post     <pre> <snap>       done + nothing else changed since pre (registry, pi_* data, jobs, other objects)
#   o2.sh same     <pre> <snap>       exactly the pre-O2 state again (after the contingency), incl. jobs and pi_* data
#   o2.sh classify <snap>             PRE | COMPLETADO | PARCIAL_SIN_REGISTRO | PARCIAL_SOLO_REGISTRO | INDETERMINADO
#   o2.sh verdict  <pre> <snap>       after the contingency: REVERTIDO (exit 0, exact pre state) | BLOQUEADO (exit 3: O2 fully
#                                     undone but documentary jobs / pi_* data changed concurrently; never overwritten) | FALLIDO (1)
#   o2.sh bind     <sha>              the checked-out commit (and GITHUB_SHA, if set) is exactly the authorized one
#   o2.sh probe                       read-only: timeouts of the session the tool opens. The Supabase pooler drops startup
#                                     options (PGOPTIONS), so lock_timeout stays 0; the bound is the role's statement_timeout.
# The two commands that WRITE (target = the connection resolveConnection() / the URL given; the workflow points them at
# production only after the gate and `pre` pass, the rehearsal only ever at its local replica):
#   o2.sh apply                       the plan's real tool, one file: apply-supabase-migration.ts <NAME>
#   o2.sh contingency <db-url>        step 1 audited 120000 rollback; ONLY if it succeeded, step 2 O2_contingencia_registro.sql
# Expected bodies and attributes are AUDITED REFERENCES: prosrc md5 of the bodies in the sha-pinned SQL files (recomputed
# here from those files and required to equal the constants below), PR198's pg_get_functiondef md5 recorded in production
# by the 2026-10-24 diagnosis, and the trigger definition the two files create. Never values read in the same run.
set -uo pipefail
PSQL=${PSQL:-/usr/lib/postgresql/17/bin/psql}
NAME=20261024120000_resume_authorization_ref_match.sql
TRG='public.pi_documentary_resume_requires_budget()'; RPC='public.pi_recovery_resume_authorization(text,text)'
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
MIG=$R/supabase/migrations/$NAME; RB=$R/supabase/proposals/${NAME%.sql}.rollback.sql; CT=$R/docs/ops/o2/O2_contingencia_registro.sql
PR198=$R/supabase/proposals/20261024000000_spend_authorizations.sql
SHA_MIG=13dffaa6ec3639a4348f6005d8f590549af3b24a930b967e452894a3f44e9fbf; SHA_RB=89d82016f005de253d76e27bdcb0a176fdf3ea759316cb538f2789a024fa7d41
SHA_CT=2c1eaee82303d62d3faafcfcb1dd14033fa848f40600f1ab5697d0548e3b7dbe; SHA_PR198=5f456283cf715af0867d312dcf244312319be128ac8e7a76204c14abb65a0696
# audited references (see header)
PRE_TRG_SRC=ca48ee92a5eda1a813d474797aa9a332; PRE_RPC_SRC=4d7378dd57f81cec9dd0301982d904ec    # PR198 file == rollback file
POST_TRG_SRC=0cf0880f21ccfed9d09d661b2b4ee882; POST_RPC_SRC=b08709ace4f5b45633a581ba71f9f3c5  # migration file
PRE_TRG_DEF=26a24f8f0b80efd7a8ca6a4aafb25466; PRE_RPC_DEF=244d8bee9cbab0b3e1ec44bbd8ca33ff    # production, DIAGNOSIS 2026-10-24
PRE_TRG_ATTR='plpgsql|v|false|u|trigger||false|search_path=""|postgres'; POST_TRG_ATTR='plpgsql|v|false|u|trigger||true|search_path=""|postgres'
RPC_ATTR='sql|s|false|u|jsonb|text,text|true|search_path=""|postgres'
TRIGGER_DEF='1|O|CREATE TRIGGER pi_documentary_resume_requires_budget BEFORE UPDATE OF status ON public.documentary_script_jobs FOR EACH ROW EXECUTE FUNCTION public.pi_documentary_resume_requires_budget()'
ACL_BOTH='{postgres=X/postgres,service_role=X/postgres}'; ACL_POSTGRES='{postgres=X/postgres}'
KEYS="read_only ma_count ma_has_o2 ma_md5_without_o2 sm_md5 pi_paid_operations open_operations pi_data_md5 pi_rows m000 m120 m130 m140 studio_tables
 trg_src_md5 trg_def_md5 trg_attr trg_acl rpc_src_md5 rpc_def_md5 rpc_attr rpc_acl exec_trg exec_rpc trigger_def other_functions_md5 other_triggers_md5
 tables_md5 acl_documentary_script_jobs acl_pi_recovery_budgets acl_pi_recovery_resume_authorizations jobs_active jobs_exhausted jobs_requeueable_new_rule
 active_recovery_budgets jobs_md5 other_locks_on_jobs long_xacts end"

snap() {
  { printf 'begin transaction read only;\nset local search_path = %s;\n' "''"; cat <<SQL; printf 'rollback;\n'; } | "$PSQL" "$1" -X -qAt -F '|' -v ON_ERROR_STOP=1 > "$2"
select 'read_only', current_setting('transaction_read_only');
select 'ma_count', count(*) from public._migrations_applied;
select 'ma_has_o2', count(*) from public._migrations_applied where name = '$NAME';
select 'ma_md5_without_o2', md5(coalesce(string_agg(name, ',' order by name), '')) from public._migrations_applied where name <> '$NAME';
select 'sm_md5', md5(coalesce(string_agg(version || ':' || coalesce(name, ''), ',' order by version), '')) from supabase_migrations.schema_migrations;
select 'pi_paid_operations', count(*) from public.pi_paid_operations;
select 'open_operations', count(*) from public.pi_paid_operations where status in ('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED');
select 'pi_data_md5', md5(string_agg(c.relname || ':' || (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(t::text, ''|'' order by t::text), '''')) h from public.%I t', c.relname), false, true, '')))[1]::text, ',' order by c.relname))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'pi\_%';
select 'pi_rows', string_agg(c.relname || ':' || (xpath('/row/n/text()', query_to_xml(format('select count(*) n from public.%I', c.relname), false, true, '')))[1]::text, ',' order by c.relname)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'pi\_%';
select 'm000', coalesce(bool_or(pg_get_functiondef(p.oid) like '%authorization missing%'), false) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'pi_submit_with_supply';
select 'm120', coalesce(bool_or(pg_get_functiondef(p.oid) like '%r.authorization_ref = b.authorization_ref%'), false) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'pi_documentary_resume_requires_budget';
select 'm130', coalesce(bool_or(pg_get_functiondef(p.oid) like '%status <> ''RESERVED''%'), false) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'pi_open_spend_authorization';
select 'm140', to_regprocedure('public.pi_supply_state_pre_studio(text)') is not null;
select 'studio_tables', to_regclass('public.podcast_studio_episodes') is not null or to_regclass('public.podcast_studio_operations') is not null;
select f || '_src_md5', md5(p.prosrc) from (values ('trg', '$TRG'), ('rpc', '$RPC')) v(f, sig) join pg_proc p on p.oid = v.sig::regprocedure order by 1;
select f || '_def_md5', md5(pg_get_functiondef(p.oid)) from (values ('trg', '$TRG'), ('rpc', '$RPC')) v(f, sig) join pg_proc p on p.oid = v.sig::regprocedure order by 1;
select f || '_attr', l.lanname || '|' || p.provolatile::text || '|' || p.proisstrict || '|' || p.proparallel::text || '|' || p.prorettype::regtype::text || '|'
  || coalesce((select string_agg(t::regtype::text, ',' order by o) from unnest(p.proargtypes::oid[]) with ordinality a(t, o)), '') || '|'
  || p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || pg_get_userbyid(p.proowner)
  from (values ('trg', '$TRG'), ('rpc', '$RPC')) v(f, sig) join pg_proc p on p.oid = v.sig::regprocedure join pg_language l on l.oid = p.prolang order by 1;
select f || '_acl', coalesce(p.proacl::text, 'NULL') from (values ('trg', '$TRG'), ('rpc', '$RPC')) v(f, sig) join pg_proc p on p.oid = v.sig::regprocedure order by 1;
select 'exec_' || f, string_agg(r || '=' || has_function_privilege(r, sig::regprocedure, 'EXECUTE'), ',' order by r)
  from (values ('trg', '$TRG'), ('rpc', '$RPC')) v(f, sig), unnest(array['anon','authenticated','service_role']) r group by f order by 1;
select 'trigger_def', count(*) || '|' || coalesce(string_agg(tgenabled::text || '|' || pg_get_triggerdef(oid), ','), '') from pg_trigger
  where not tgisinternal and tgname = 'pi_documentary_resume_requires_budget';
select 'other_functions_md5', md5(string_agg(p.oid::regprocedure::text || '=' || md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind in ('f','p')
  and p.oid not in ('$TRG'::regprocedure, '$RPC'::regprocedure);
select 'other_triggers_md5', md5(coalesce(string_agg(tgrelid::regclass::text || '.' || tgname || ':' || tgenabled::text || ':' || md5(pg_get_triggerdef(oid)), ',' order by 1), ''))
  from pg_trigger where not tgisinternal and tgname <> 'pi_documentary_resume_requires_budget';
select 'tables_md5', md5(string_agg(c.relname || ':' || c.relkind::text || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity, ',' order by c.relname))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v','m','p');
select 'acl_' || t, coalesce(c.relacl::text, 'NULL') from unnest(array['pi_recovery_resume_authorizations','pi_recovery_budgets','documentary_script_jobs']) t
  join pg_class c on c.oid = to_regclass('public.' || t) order by 1;
select 'jobs_active', count(*) from public.documentary_script_jobs where status in ('queued','running');
select 'jobs_exhausted', count(*) from public.documentary_script_jobs where status = 'failed' and retry_count >= 3;
select 'jobs_requeueable_new_rule', count(*) from public.documentary_script_jobs j where j.status = 'failed' and j.retry_count >= 3 and exists (
  select 1 from public.pi_recovery_budgets b join public.pi_recovery_resume_authorizations r on r.project_id = b.project_id and r.authorization_ref = b.authorization_ref
  where b.job_id = j.id and b.owner_id = j.user_id and b.status = 'ACTIVE' and length(trim(coalesce(b.authorization_ref, ''))) > 0 and r.transaction_id is not null);
select 'active_recovery_budgets', count(*) from public.pi_recovery_budgets where status = 'ACTIVE';
select 'jobs_md5', md5(coalesce(string_agg(id::text || ':' || status || ':' || retry_count || ':' || coalesce(updated_at::text, ''), ',' order by id), '')) from public.documentary_script_jobs;
select 'other_locks_on_jobs', count(*) from pg_locks l where l.relation = 'public.documentary_script_jobs'::regclass and l.pid <> pg_backend_pid();
select 'long_xacts', count(*) from pg_stat_activity where pid <> pg_backend_pid() and xact_start < now() - interval '60 seconds' and state <> 'idle';
select 'end', 'ok';
SQL
}

get() { awk -F'|' -v k="$2" '$1 == k { sub(/^[^|]*[|]/, ""); print; exit }' "$1"; }
fails=0
chk() { if [ "$2" = "$3" ]; then echo "PASS O2[$1] $4 = $2"; else echo "FAIL O2[$1] $4 = $2 (expected $3)"; fails=$((fails+1)); fi; }
same_as() { chk "$1" "$(get "$3" "$4")" "$(get "$2" "$4")" "$4 unchanged"; }
# a snapshot is usable only if it is complete: every fact present, non-empty, read-only, terminator reached
complete() { local miss=""; for k in $KEYS; do [ -n "$(get "$2" "$k")" ] || miss="$miss $k"; done
  [ -s "$2" ] && [ -z "$miss" ] && [ "$(get "$2" read_only)" = on ] && [ "$(get "$2" end)" = ok ] && echo "PASS O2[$1] snapshot complete ($(wc -l < "$2") facts)" \
    || { echo "FAIL O2[$1] snapshot $2 incomplete or not read-only (missing:${miss:- none})"; fails=$((fails+1)); }; }
hashes() { [ "$(sha256sum < "$MIG" | cut -d' ' -f1)" = $SHA_MIG ] && cmp -s "$MIG" "$R/supabase/proposals/$NAME" && [ "$(sha256sum < "$RB" | cut -d' ' -f1)" = $SHA_RB ] \
  && [ "$(sha256sum < "$CT" | cut -d' ' -f1)" = $SHA_CT ] && [ "$(sha256sum < "$PR198" | cut -d' ' -f1)" = $SHA_PR198 ] \
  || { echo "FAIL O2 sha256 of the migration / rollback / contingency / PR198 differs from the audited one"; exit 1; }; }
# recompute the body references from the sha-pinned files: they must equal the constants (the constants are not trusted alone)
srcmd5() { python3 -I -c 'import re,sys,hashlib; s=open(sys.argv[1]).read(); m=[x for x in re.finditer(r"create or replace function (public\.\w+)\(.*?as \$\$(.*?)\$\$", s, re.S | re.I) if x.group(1) == sys.argv[2]]; print(hashlib.md5(m[-1].group(2).encode()).hexdigest() if m else "none")' "$1" "$2"; }
refs() { hashes; local ok=1
  [ "$(srcmd5 "$PR198" public.pi_documentary_resume_requires_budget)$(srcmd5 "$RB" public.pi_documentary_resume_requires_budget)" = "$PRE_TRG_SRC$PRE_TRG_SRC" ] || ok=0
  [ "$(srcmd5 "$PR198" public.pi_recovery_resume_authorization)$(srcmd5 "$RB" public.pi_recovery_resume_authorization)" = "$PRE_RPC_SRC$PRE_RPC_SRC" ] || ok=0
  [ "$(srcmd5 "$MIG" public.pi_documentary_resume_requires_budget)$(srcmd5 "$MIG" public.pi_recovery_resume_authorization)" = "$POST_TRG_SRC$POST_RPC_SRC" ] || ok=0
  [ $ok = 1 ] || { echo "FAIL O2 audited body references do not match the sha-pinned SQL files"; exit 1; }; }
pre_objects() { # $1 tag, $2 snap: both functions and the trigger exactly as PR198 / the rollback leave them (production 2026-10-24)
  chk "$1" "$(get $2 trg_src_md5)|$(get $2 trg_def_md5)" "$PRE_TRG_SRC|$PRE_TRG_DEF" "trigger fn body (prosrc md5 | functiondef md5) == PR198"
  chk "$1" "$(get $2 rpc_src_md5)|$(get $2 rpc_def_md5)" "$PRE_RPC_SRC|$PRE_RPC_DEF" "RPC body (prosrc md5 | functiondef md5) == PR198"
  chk "$1" "$(get $2 trg_attr)" "$PRE_TRG_ATTR" "trigger fn lang|volatility|strict|parallel|returns|args|secdef|config|owner"
  chk "$1" "$(get $2 rpc_attr)" "$RPC_ATTR" "RPC lang|volatility|strict|parallel|returns|args|secdef|config|owner"
  chk "$1" "$(get $2 trg_acl)|$(get $2 rpc_acl)" "$ACL_BOTH|$ACL_BOTH" "ACL trigger fn | RPC"
  chk "$1" "$(get $2 exec_trg)|$(get $2 exec_rpc)" "anon=false,authenticated=false,service_role=true|anon=false,authenticated=false,service_role=true" "EXECUTE trigger fn | RPC"
  chk "$1" "$(get $2 trigger_def)" "$TRIGGER_DEF" "trigger: count|enabled|full definition"; }
post_objects() { # $1 tag, $2 snap: exactly what the audited migration creates
  chk "$1" "$(get $2 trg_src_md5)" "$POST_TRG_SRC" "trigger fn body (prosrc md5) == migration 13dffaa6"
  chk "$1" "$(get $2 rpc_src_md5)" "$POST_RPC_SRC" "RPC body (prosrc md5) == migration 13dffaa6"
  chk "$1" "$(get $2 trg_attr)" "$POST_TRG_ATTR" "trigger fn lang|volatility|strict|parallel|returns|args|secdef|config|owner"
  chk "$1" "$(get $2 rpc_attr)" "$RPC_ATTR" "RPC lang|volatility|strict|parallel|returns|args|secdef|config|owner"
  chk "$1" "$(get $2 trg_acl)|$(get $2 rpc_acl)" "$ACL_POSTGRES|$ACL_BOTH" "ACL trigger fn | RPC"
  chk "$1" "$(get $2 exec_trg)|$(get $2 exec_rpc)" "anon=false,authenticated=false,service_role=false|anon=false,authenticated=false,service_role=true" "EXECUTE trigger fn | RPC"
  chk "$1" "$(get $2 trigger_def)" "$TRIGGER_DEF" "trigger: count|enabled|full definition"; }
done_state() { # $1 tag, $2 snap
  chk "$1" "$(get $2 ma_count)|$(get $2 ma_has_o2)" "64|1" "_migrations_applied rows | $NAME registered"
  chk "$1" "$(get $2 m000)$(get $2 m120)$(get $2 m130)$(get $2 m140)|$(get $2 studio_tables)" "ttff|f" "markers 000000/120000/130000/140000 | studio tables"
  post_objects "$1" "$2"; }

case "${1:-}" in
  snap) snap "$2" "$3" || { echo "FAIL O2[snap] read-only snapshot query failed"; exit 1; }; complete snap "$3";;
  pre)
    refs; s=$2; complete pre $s
    chk pre "$(get $s ma_count)|$(get $s ma_has_o2)" "63|0" "_migrations_applied rows | $NAME registered"
    chk pre "$(get $s pi_paid_operations)|$(get $s open_operations)" "548|41" "pi_paid_operations rows | open"
    chk pre "$(get $s m000)$(get $s m120)$(get $s m130)$(get $s m140)|$(get $s studio_tables)" "tfff|f" "markers 000000/120000/130000/140000 | studio tables"
    pre_objects pre $s
    chk pre "$(get $s jobs_active)|$(get $s other_locks_on_jobs)|$(get $s long_xacts)" "0|0|0" "jobs queued/running | other locks on documentary_script_jobs | non-idle xacts > 60 s"
    chk pre "$(get $s jobs_requeueable_new_rule)" 0 "exhausted jobs the 120000 rule would let requeue (O2 must not unlock spend)"
    echo "INFO pre: exhausted documentary jobs=$(get $s jobs_exhausted), ACTIVE recovery budgets=$(get $s active_recovery_budgets)";;
  done) refs; complete done "$2"; done_state done "$2";;
  post)
    refs; p=$2; s=$3; complete post-pre $p; complete post $s; done_state post $s
    for k in ma_md5_without_o2 sm_md5 pi_paid_operations open_operations pi_data_md5 other_functions_md5 other_triggers_md5 tables_md5 \
             acl_documentary_script_jobs acl_pi_recovery_budgets acl_pi_recovery_resume_authorizations jobs_active jobs_md5; do same_as post $p $s $k; done;;
  same)
    refs; p=$2; s=$3; complete restored-pre $p; complete restored $s; pre_objects restored $s
    for k in ma_count ma_has_o2 ma_md5_without_o2 sm_md5 pi_paid_operations open_operations pi_data_md5 m000 m120 m130 m140 studio_tables \
             trg_src_md5 trg_def_md5 trg_attr trg_acl rpc_src_md5 rpc_def_md5 rpc_attr rpc_acl exec_trg exec_rpc trigger_def \
             other_functions_md5 other_triggers_md5 tables_md5 acl_documentary_script_jobs acl_pi_recovery_budgets acl_pi_recovery_resume_authorizations \
             jobs_active jobs_md5; do same_as restored $p $s $k; done;;
  classify)
    refs; s=$2; c=INDETERMINADO
    if bash "$0" complete-only "$s" >/dev/null; then
      po=$( (pre_objects x "$s" >/dev/null; echo $fails) ); fails=0; dn=$( (done_state x "$s" >/dev/null; echo $fails) ); fails=0
      has=$(get $s ma_has_o2); m=$(get $s m120)
      if [ "$po" = 0 ] && [ "$has" = 0 ]; then c=PRE
      elif [ "$dn" = 0 ]; then c=COMPLETADO
      elif [ "$m" = t ] && [ "$has" = 0 ]; then c=PARCIAL_SIN_REGISTRO
      elif [ "$po" = 0 ] && [ "$has" = 1 ]; then c=PARCIAL_SOLO_REGISTRO
      fi
    fi
    echo "O2 STATE: $c"; [ "$c" != INDETERMINADO ]; exit $?;;
  complete-only) complete check "$2";;
  verdict)
    out=$(bash "$0" same "$2" "$3"); f=$(printf '%s\n' "$out" | grep '^FAIL' || true)
    if [ -z "$f" ]; then echo "O2 VERDICT: REVERTIDO (exact pre-O2 state)"; exit 0; fi
    printf '%s\n' "$f"
    other=$(printf '%s\n' "$f" | grep -vE '^FAIL O2\[restored\] (jobs_md5|jobs_active|pi_data_md5|pi_paid_operations|open_operations) unchanged' || true)
    if [ -z "$other" ]; then echo "O2 VERDICT: BLOQUEADO (O2 undone exactly; concurrent changes in jobs / pi_* data left as they are)"; exit 3; fi
    echo "O2 VERDICT: FALLIDO (state is not the pre-O2 state)"; exit 1;;
  bind)
    head=$(git -C "$R" rev-parse HEAD)
    chk bind "$head" "$2" "checked-out commit == authorized SHA"
    [ -z "${GITHUB_SHA:-}" ] || chk bind "$GITHUB_SHA" "$2" "GITHUB_SHA == authorized SHA"
    chk bind "$(git -C "$R" status --porcelain --untracked-files=no | wc -l)" 0 "no local modification of tracked files";;
  probe)
    out=$(cd "$R" && npx tsx -e 'import { connectResolved } from "./scripts/lib/supabase-db"; (async () => { const { client } = await connectResolved(); const r = await client.query("begin transaction read only; show lock_timeout; show statement_timeout; show transaction_read_only; rollback;"); console.log((r as any).filter((x: any) => x.rows?.length).map((x: any) => Object.values(x.rows[0])[0]).join(",")); await client.end(); })().catch((e) => { console.error(e.message); process.exit(1); })' 2>&1 | tail -1)
    echo "INFO probe: lock_timeout,statement_timeout,transaction_read_only on the tool's own connection = $out"
    chk probe "$(echo "$out" | cut -d, -f2-)" "${EXPECT_STATEMENT_TIMEOUT:-2min},on" "statement_timeout (bounds any lock wait of the migration),read-only probe";;
  apply)
    refs; echo "apply (no lock_timeout through the pooler; bound = statement_timeout): sha256 migration $SHA_MIG (== proposal), rollback $SHA_RB, contingency $SHA_CT"
    (cd "$R" && timeout 300 npx tsx scripts/apply-supabase-migration.ts "$NAME") 2>&1 | tee "${OUT:-.}/o2-apply.log"; rc=${PIPESTATUS[0]}
    chk apply "$rc" 0 "apply-supabase-migration.ts exit code"
    chk apply "$(grep -c "Resumen: 1 aplicada(s) \[$NAME\], 0 reconciliada(s)" "${OUT:-.}/o2-apply.log")" 1 "tool summary: exactly 1 applied ($NAME), 0 reconciled";;
  contingency)
    refs; echo "contingency: step 1 rollback $SHA_RB, step 2 $SHA_CT"
    "$PSQL" "$2" -X -v ON_ERROR_STOP=1 -f "$RB"; rc=$?
    chk contingency $rc 0 "step 1: audited 120000 rollback (restores the PR198 bodies)"
    if [ $rc != 0 ]; then echo "FAIL O2[contingency] step 1 failed: STOP, step 2 NOT run (state must be classified and reported)"; echo "RESULT o2 contingency: $fails FAIL"; exit 1; fi
    "$PSQL" "$2" -X -v ON_ERROR_STOP=1 -f "$CT"; chk contingency $? 0 "step 2: re-grant service_role on the trigger fn + remove the registry row";;
  *) echo "usage: o2.sh snap|pre|done|post|same|classify|bind|probe|apply|contingency …"; exit 2;;
esac
echo "RESULT o2 ${1}: $fails FAIL"
[ $fails = 0 ]
