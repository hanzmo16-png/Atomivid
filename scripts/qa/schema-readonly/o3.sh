#!/usr/bin/env bash
# O3 checks (migration 20261024130000_spend_authorization_baseline_fix.sql). READ ONLY: every query runs inside
# BEGIN TRANSACTION READ ONLY … ROLLBACK. Same model as o2.sh: shared by the one-shot production workflow and the
# disposable-replica rehearsal; prints only counts, booleans, ACL strings, definitions and md5 digests.
#   o3.sh snap     <db-url> <out>     snapshot (fails if incomplete or with a duplicated key)
#   o3.sh pre      <snap>             the audited pre-O3 state (O2 done, 130000 absent, PR198 body)
#   o3.sh done     <snap>             the audited post-O3 state, absolute: what O4 must require
#   o3.sh post     <pre> <snap>       done + nothing else changed (registry, pi_* data, authorizations and their usage,
#                                     podcast episodes, documentary jobs, every other function / trigger / table)
#   o3.sh same     <pre> <snap>       exactly the pre-O3 state again (after the contingency)
#   o3.sh verdict  <pre> <snap>       REVERTIDO (0) | BLOQUEADO (3: concurrent data drift, never overwritten) | FALLIDO (1)
#   o3.sh classify <snap>             PRE | COMPLETADO | PARCIAL_SIN_REGISTRO | PARCIAL_SOLO_REGISTRO | INDETERMINADO
#   o3.sh o2run    <run-id>           GitHub API (read): the O2 run is the authorized one-shot run and concluded success
#   o3.sh bind     <sha>              checked-out commit (and GITHUB_SHA) is exactly the authorized one, no local edits
#   o3.sh probe                       read-only timeouts of the tool's own connection (statement_timeout 2min)
# Writes (production only after gate + pre pass; the rehearsal only on its local replica):
#   o3.sh apply                       apply-supabase-migration.ts <NAME>, exactly 1 applied / 0 reconciled
#   o3.sh contingency <db-url>        step 1 audited 130000 rollback; ONLY if it succeeded, step 2 O3_contingencia_registro.sql
# References are AUDITED: prosrc md5 of the body in the sha-pinned files (PR198 == rollback; the migration), recomputed
# from those files on every run and required to equal the constants; attributes and ACL from what the files declare.
set -uo pipefail
PSQL=${PSQL:-/usr/lib/postgresql/17/bin/psql}
NAME=20261024130000_spend_authorization_baseline_fix.sql; O2NAME=20261024120000_resume_authorization_ref_match.sql
FN='public.pi_open_spend_authorization(uuid,numeric,text)'; FNAME=public.pi_open_spend_authorization
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
MIG=$R/supabase/migrations/$NAME; RB=$R/supabase/proposals/${NAME%.sql}.rollback.sql; CT=$R/docs/ops/o3/O3_contingencia_registro.sql
PR198=$R/supabase/proposals/20261024000000_spend_authorizations.sql
SHA_MIG=56a24ada7fe457dbb7d301946bac916cfcc313c1c0c39baee5d76ff4da21cd6b; SHA_RB=5d7a3b1f37d040b98eabce46149be83538b18a3e544b97b9f6f72d4b6d9dea6f
SHA_PR198=5f456283cf715af0867d312dcf244312319be128ac8e7a76204c14abb65a0696; SHA_CT=${SHA_CT_OVERRIDE:-92242fd6924b91b9c0e7e204892eac31028226cf6c9bcbfea6ba53761bc03c1b}
PRE_SRC=d5f7688c6e9029d13d227d0fd5f9d8ec; POST_SRC=2e4d0b99053389a361a0492095f07254
ATTR='plpgsql|v|false|u|jsonb|uuid,numeric,text|true|search_path=""|postgres'
ACL='{postgres=X/postgres,service_role=X/postgres}'; EXEC='anon=false,authenticated=false,service_role=true'
O2_RUN=40427566003; O2_SHA=0d55b5b5f6478861d5121bdee835efd5ddc2e05c
KEYS="read_only ma_count ma_has_o2 ma_has_o3 ma_md5_without_o3 sm_md5 pi_paid_operations open_operations pi_data_md5 pi_rows m000 m120 m130 m140
 studio_tables fn_src_md5 fn_def_md5 fn_attr fn_acl exec_fn other_functions_md5 triggers_md5 tables_md5 auth_rows auth_md5 usage_md5
 podcast_busy podcast_md5 jobs_active jobs_md5 long_xacts end"

snap() {
  { printf 'begin transaction read only;\nset local search_path = %s;\n' "''"; cat <<SQL; printf 'rollback;\n'; } | "$PSQL" "$1" -X -qAt -F '|' -v ON_ERROR_STOP=1 > "$2"
select 'read_only', current_setting('transaction_read_only');
select 'ma_count', count(*) from public._migrations_applied;
select 'ma_has_o2', count(*) from public._migrations_applied where name = '$O2NAME';
select 'ma_has_o3', count(*) from public._migrations_applied where name = '$NAME';
select 'ma_md5_without_o3', md5(coalesce(string_agg(name, ',' order by name), '')) from public._migrations_applied where name <> '$NAME';
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
select 'fn_src_md5', md5(prosrc) from pg_proc where oid = '$FN'::regprocedure;
select 'fn_def_md5', md5(pg_get_functiondef('$FN'::regprocedure));
select 'fn_attr', l.lanname || '|' || p.provolatile::text || '|' || p.proisstrict || '|' || p.proparallel::text || '|' || p.prorettype::regtype::text || '|'
  || coalesce((select string_agg(t::regtype::text, ',' order by o) from unnest(p.proargtypes::oid[]) with ordinality a(t, o)), '') || '|'
  || p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || pg_get_userbyid(p.proowner)
  from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = '$FN'::regprocedure;
select 'fn_acl', coalesce(proacl::text, 'NULL') from pg_proc where oid = '$FN'::regprocedure;
select 'exec_fn', string_agg(r || '=' || has_function_privilege(r, '$FN'::regprocedure, 'EXECUTE'), ',' order by r) from unnest(array['anon','authenticated','service_role']) r;
select 'other_functions_md5', md5(string_agg(p.oid::regprocedure::text || '=' || md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind in ('f','p') and p.oid <> '$FN'::regprocedure;
select 'triggers_md5', md5(coalesce(string_agg(tgrelid::regclass::text || '.' || tgname || ':' || tgenabled::text || ':' || md5(pg_get_triggerdef(oid)), ',' order by 1), ''))
  from pg_trigger where not tgisinternal;
select 'tables_md5', md5(string_agg(c.relname || ':' || c.relkind::text || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity, ',' order by c.relname))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v','m','p');
select 'auth_rows', count(*) from public.pi_spend_authorizations;
select 'auth_md5', md5(coalesce(string_agg(a::text, '|' order by a::text), '')) from public.pi_spend_authorizations a;
select 'usage_md5', md5(coalesce(string_agg(project_id || '=' || public.pi_spend_authorization_usage(project_id)::text, '|' order by project_id), '')) from public.pi_spend_authorizations;
select 'podcast_busy', count(*) from public.podcast_episodes where video_status in ('queued','running','scheduled');
select 'podcast_md5', md5(coalesce(string_agg(id::text || ':' || coalesce(status, '') || ':' || coalesce(video_status, '') || ':' || coalesce(updated_at::text, ''), ',' order by id), '')) from public.podcast_episodes;
select 'jobs_active', count(*) from public.documentary_script_jobs where status in ('queued','running');
select 'jobs_md5', md5(coalesce(string_agg(id::text || ':' || status || ':' || retry_count || ':' || coalesce(updated_at::text, ''), ',' order by id), '')) from public.documentary_script_jobs;
select 'long_xacts', count(*) from pg_stat_activity where pid <> pg_backend_pid() and xact_start < now() - interval '60 seconds' and state <> 'idle';
select 'end', 'ok';
SQL
}

get() { awk -F'|' -v k="$2" '$1 == k { sub(/^[^|]*[|]/, ""); print; exit }' "$1"; }
fails=0
chk() { if [ "$2" = "$3" ]; then echo "PASS O3[$1] $4 = $2"; else echo "FAIL O3[$1] $4 = $2 (expected $3)"; fails=$((fails+1)); fi; }
same_as() { chk "$1" "$(get "$3" "$4")" "$(get "$2" "$4")" "$4 unchanged"; }
complete() { local miss="" dup; for k in $KEYS; do [ -n "$(get "$2" "$k")" ] || miss="$miss $k"; done
  dup=$(cut -d'|' -f1 "$2" 2>/dev/null | sort | uniq -d | paste -sd' ')
  [ -s "$2" ] && [ -z "$miss" ] && [ -z "$dup" ] && [ "$(get "$2" read_only)" = on ] && [ "$(get "$2" end)" = ok ] && echo "PASS O3[$1] snapshot complete ($(wc -l < "$2") facts, no duplicate key)" \
    || { echo "FAIL O3[$1] snapshot $2 incomplete, duplicated or not read-only (missing:${miss:- none}; duplicated:${dup:- none})"; fails=$((fails+1))
         # fail closed: no other check may run on a broken snapshot (it would only add noise to the verdict)
         echo "RESULT o3 ${CMD}: $fails FAIL (stopped: broken snapshot)"; exit 1; }; }
hashes() { [ "$(sha256sum < "$MIG" | cut -d' ' -f1)" = $SHA_MIG ] && cmp -s "$MIG" "$R/supabase/proposals/$NAME" && [ "$(sha256sum < "$RB" | cut -d' ' -f1)" = $SHA_RB ] \
  && [ "$(sha256sum < "$CT" | cut -d' ' -f1)" = "$SHA_CT" ] && [ "$(sha256sum < "$PR198" | cut -d' ' -f1)" = $SHA_PR198 ] \
  || { echo "FAIL O3 sha256 of the migration / rollback / contingency / PR198 differs from the audited one"; exit 1; }; }
srcmd5() { python3 -I -c 'import re,sys,hashlib; s=open(sys.argv[1]).read(); m=[x for x in re.finditer(r"create or replace function (public\.\w+)\(.*?as \$\$(.*?)\$\$", s, re.S | re.I) if x.group(1) == sys.argv[2]]; print(hashlib.md5(m[-1].group(2).encode()).hexdigest() if m else "none")' "$1" "$2"; }
refs() { hashes; [ "$(srcmd5 "$PR198" $FNAME)$(srcmd5 "$RB" $FNAME)$(srcmd5 "$MIG" $FNAME)" = "$PRE_SRC$PRE_SRC$POST_SRC" ] \
  || { echo "FAIL O3 audited body references do not match the sha-pinned SQL files"; exit 1; }; }
objects() { # $1 tag $2 snap $3 expected prosrc md5
  chk "$1" "$(get $2 fn_src_md5)" "$3" "pi_open_spend_authorization body (prosrc md5) == $([ "$3" = $PRE_SRC ] && echo PR198 || echo 'migration 56a24ada')"
  chk "$1" "$(get $2 fn_attr)" "$ATTR" "lang|volatility|strict|parallel|returns|args|secdef|config|owner"
  chk "$1" "$(get $2 fn_acl)|$(get $2 exec_fn)" "$ACL|$EXEC" "ACL | EXECUTE"; }
done_state() {
  chk "$1" "$(get $2 ma_count)|$(get $2 ma_has_o2)|$(get $2 ma_has_o3)" "65|1|1" "_migrations_applied rows | 120000 | 130000 registered"
  chk "$1" "$(get $2 m000)$(get $2 m120)$(get $2 m130)$(get $2 m140)|$(get $2 studio_tables)" "tttf|f" "markers 000000/120000/130000/140000 | studio tables"
  objects "$1" "$2" $POST_SRC; }
DATA_KEYS="pi_paid_operations open_operations pi_data_md5 auth_rows auth_md5 usage_md5 podcast_busy podcast_md5 jobs_active jobs_md5"

CMD=${1:-}
case "${1:-}" in
  snap) snap "$2" "$3" || { echo "FAIL O3[snap] read-only snapshot query failed"; exit 1; }; complete snap "$3";;
  pre)
    refs; s=$2; complete pre $s
    chk pre "$(get $s ma_count)|$(get $s ma_has_o2)|$(get $s ma_has_o3)" "64|1|0" "_migrations_applied rows | 120000 | 130000 registered"
    chk pre "$(get $s pi_paid_operations)|$(get $s open_operations)" "548|41" "pi_paid_operations rows | open"
    chk pre "$(get $s m000)$(get $s m120)$(get $s m130)$(get $s m140)|$(get $s studio_tables)" "ttff|f" "markers 000000/120000/130000/140000 | studio tables"
    objects pre $s $PRE_SRC
    chk pre "$(get $s podcast_busy)|$(get $s jobs_active)|$(get $s long_xacts)" "0|0|0" "podcast queued/running/scheduled | documentary jobs active | non-idle xacts > 60 s"
    echo "INFO pre: spend authorizations=$(get $s auth_rows)";;
  done) refs; complete done "$2"; done_state done "$2";;
  post)
    refs; p=$2; s=$3; complete post-pre $p; complete post $s; done_state post $s
    for k in ma_md5_without_o3 sm_md5 $DATA_KEYS other_functions_md5 triggers_md5 tables_md5; do same_as post $p $s $k; done;;
  same)
    refs; p=$2; s=$3; complete restored-pre $p; complete restored $s; objects restored $s $PRE_SRC
    for k in ma_count ma_has_o2 ma_has_o3 ma_md5_without_o3 sm_md5 m000 m120 m130 m140 studio_tables fn_src_md5 fn_def_md5 fn_attr fn_acl exec_fn \
             other_functions_md5 triggers_md5 tables_md5 $DATA_KEYS; do same_as restored $p $s $k; done;;
  verdict)
    out=$(bash "$0" same "$2" "$3"); f=$(printf '%s\n' "$out" | grep '^FAIL' || true)
    if [ -z "$f" ]; then echo "O3 VERDICT: REVERTIDO (exact pre-O3 state)"; exit 0; fi
    printf '%s\n' "$f"
    other=$(printf '%s\n' "$f" | grep -vE "^FAIL O3\[restored\] ($(echo $DATA_KEYS | tr ' ' '|')) unchanged" || true)
    if [ -z "$other" ]; then echo "O3 VERDICT: BLOQUEADO (O3 undone exactly; concurrent changes in data left as they are)"; exit 3; fi
    echo "O3 VERDICT: FALLIDO (state is not the pre-O3 state)"; exit 1;;
  complete-only) complete check "$2";;
  classify)
    refs; s=$2; c=INDETERMINADO
    if bash "$0" complete-only "$s" >/dev/null; then
      po=$( (objects x "$s" $PRE_SRC >/dev/null; echo $fails) ); fails=0; dn=$( (done_state x "$s" >/dev/null; echo $fails) ); fails=0
      has=$(get $s ma_has_o3); m=$(get $s m130); o2=$(get $s ma_has_o2)
      if [ "$o2" != 1 ] || [ "$(get $s m120)" != t ]; then c=INDETERMINADO
      elif [ "$po" = 0 ] && [ "$has" = 0 ]; then c=PRE
      elif [ "$dn" = 0 ]; then c=COMPLETADO
      elif [ "$m" = t ] && [ "$has" = 0 ]; then c=PARCIAL_SIN_REGISTRO
      elif [ "$po" = 0 ] && [ "$has" = 1 ]; then c=PARCIAL_SOLO_REGISTRO
      fi
    fi
    echo "O3 STATE: $c"; [ "$c" != INDETERMINADO ]; exit $?;;
  o2run) # read-only GitHub API: O2 must be the one-shot run on the authorized SHA, concluded success
    j=$(curl -fsS -H "Authorization: Bearer ${GITHUB_TOKEN:?}" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/${GITHUB_REPOSITORY:?}/actions/runs/$2") || { echo "FAIL O3[o2run] cannot read run $2"; exit 1; }
    v=$(printf '%s' "$j" | python3 -I -c 'import json,sys; r=json.load(sys.stdin); print("|".join(str(r.get(k)) for k in ("path","event","head_sha","status","conclusion")))')
    chk o2run "$2|$v" "$O2_RUN|.github/workflows/o2-ejecucion-unica.yml|workflow_dispatch|$O2_SHA|completed|success" "O2 run | workflow | event | SHA | status | conclusion";;
  bind)
    chk bind "$(git -C "$R" rev-parse HEAD)" "$2" "checked-out commit == authorized SHA"
    [ -z "${GITHUB_SHA:-}" ] || chk bind "$GITHUB_SHA" "$2" "GITHUB_SHA == authorized SHA"
    chk bind "$(git -C "$R" status --porcelain --untracked-files=no | wc -l)" 0 "no local modification of tracked files";;
  probe)
    out=$(cd "$R" && npx tsx -e 'import { connectResolved } from "./scripts/lib/supabase-db"; (async () => { const { client } = await connectResolved(); const r = await client.query("begin transaction read only; show lock_timeout; show statement_timeout; show transaction_read_only; rollback;"); console.log((r as any).filter((x: any) => x.rows?.length).map((x: any) => Object.values(x.rows[0])[0]).join(",")); await client.end(); })().catch((e) => { console.error(e.message); process.exit(1); })' 2>&1 | tail -1)
    echo "INFO probe: lock_timeout,statement_timeout,transaction_read_only on the tool's own connection = $out"
    chk probe "$(echo "$out" | cut -d, -f2-)" "${EXPECT_STATEMENT_TIMEOUT:-2min},on" "statement_timeout,read-only probe";;
  apply)
    refs; echo "apply: sha256 migration $SHA_MIG (== proposal), rollback $SHA_RB, contingency $SHA_CT"
    (cd "$R" && timeout 300 npx tsx scripts/apply-supabase-migration.ts "$NAME") 2>&1 | tee "${OUT:-.}/o3-apply.log"; rc=${PIPESTATUS[0]}
    chk apply "$rc" 0 "apply-supabase-migration.ts exit code"
    chk apply "$(grep -c "Resumen: 1 aplicada(s) \[$NAME\], 0 reconciliada(s)" "${OUT:-.}/o3-apply.log")" 1 "tool summary: exactly 1 applied ($NAME), 0 reconciled";;
  contingency)
    refs; echo "contingency: step 1 rollback $SHA_RB, step 2 $SHA_CT"
    "$PSQL" "$2" -X -v ON_ERROR_STOP=1 -f "$RB"; rc=$?
    chk contingency $rc 0 "step 1: audited 130000 rollback (restores the PR198 body)"
    if [ $rc != 0 ]; then echo "FAIL O3[contingency] step 1 failed: STOP, step 2 NOT run (state must be classified and reported)"; echo "RESULT o3 contingency: $fails FAIL"; exit 1; fi
    "$PSQL" "$2" -X -v ON_ERROR_STOP=1 -f "$CT"; chk contingency $? 0 "step 2: remove the 130000 registry row";;
  *) echo "usage: o3.sh snap|pre|done|post|same|verdict|classify|o2run|bind|probe|apply|contingency …"; exit 2;;
esac
echo "RESULT o3 ${1}: $fails FAIL"
[ $fails = 0 ]
