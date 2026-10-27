#!/usr/bin/env bash
# O8 checks (migration 20261024140000_podcast_v3_studio.sql: Podcast Studio tables + supply wrappers). READ ONLY: every
# query runs inside BEGIN TRANSACTION READ ONLY … ROLLBACK. Same model as o3.sh: shared by the one-shot production
# workflow and the disposable-replica rehearsal; prints only counts, booleans, definitions and md5 digests.
#   o8.sh snap     <db-url> <out>     snapshot (fails if incomplete or with a duplicated key)
#   o8.sh pre      <snap>             audited pre-O8 state (O3 done, 140000 absent, supply functions as 20261005150229)
#   o8.sh done     <snap>             audited post-O8 state, absolute: 140000 objects, empty studio ledger, access by role
#   o8.sh post     <pre> <snap>       done + nothing else changed (registry, pi_* data, supply state, every other object)
#   o8.sh same     <pre> <snap>       exactly the pre-O8 state again (after the contingency)
#   o8.sh verdict  <pre> <snap>       REVERTIDO (0) | BLOQUEADO (3: concurrent data drift, never overwritten) | FALLIDO (1)
#   o8.sh classify <snap>             PRE | COMPLETADO | PARCIAL_SIN_REGISTRO | PARCIAL_SOLO_REGISTRO | INDETERMINADO
#   o8.sh o3run    <run-id>           GitHub API (read): the O3 run is the authorized one-shot run and concluded success
#   o8.sh bind     <sha>              checked-out commit (and GITHUB_SHA) is exactly the authorized one, no local edits
#   o8.sh probe                       read-only timeouts of the tool's own connection (statement_timeout 2min)
# Writes (production only after gate + pre pass; the rehearsal only on its local replica):
#   o8.sh apply                       apply-supabase-migration.ts <NAME>: SQL + registry in ONE transaction (the file has
#                                     no begin/commit of its own), exactly 1 applied / 0 reconciled
#   o8.sh contingency <db-url>        step 1: guard (140000 present, 0 studio rows) + audited 140000 rollback in ONE
#                                     transaction (the rollback is NOT idempotent: on a pre-O8 state it would drop
#                                     pi_supply_state, so the guard refuses); ONLY if it
#                                     succeeded, step 2: O8_contingencia_registro.sql (remove the registry row)
# References are AUDITED: prosrc md5 of every touched body, recomputed on every run from the sha-pinned files
# (pre = 20261005150229 == the rollback; post = 140000) and required to equal the constants. Access is checked by
# role (effective privileges, RLS, policies), not by literal ACL strings, which depend on the platform's default
# privileges: anon/authenticated never execute the functions nor write the tables; service_role does.
set -uo pipefail
PSQL=${PSQL:-/usr/lib/postgresql/17/bin/psql}
NAME=20261024140000_podcast_v3_studio.sql; O3NAME=20261024130000_spend_authorization_baseline_fix.sql
R=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
MIG=$R/supabase/migrations/$NAME; RB=$R/supabase/proposals/${NAME%.sql}.rollback.sql; CT=$R/docs/ops/o8/O8_contingencia_registro.sql
PRE_FILE=$R/supabase/migrations/20261005150229_provider_supply_job_reservations.sql
SHA_MIG=7133f9a4d727814d13b59b293b2ae159174728514e0620ada218ca7d84185b57; SHA_RB=c2ab5b55990667a622fa24d850ba5aa76c1858851ebe5d6037d70f1cd4b50759
SHA_PRE=${SHA_PRE_OVERRIDE:-0da15603bccb15c3972ac71c37c1292d6c7eb0a46d33c6b754402824ee39c8fa}; SHA_CT=${SHA_CT_OVERRIDE:-f72fe131ebf6a04116b43872fd7af6894a4482d6bccd045e97c74db48816b959}
SPEND_PRE=15f511954308de9468c448d9b75c6419; STATE_PRE=5057aaf5d48eba5e4ad84f09dad0c13b; SPEND_POST=10e36eb37c0baa637c4f874d089bc0f7; STATE_POST=6eabcab0047a319ad79d2c66e91fd7df; COUNTS_POST=fa1817e3ba363bff1c30e173538b5518; CAP_POST=8d4ff0a8ca0bb7e6b24f01c44064619d
O3_SHA=${O3_SHA:-4d27cb81db53a2b040ddec7774d4b428500749d4}
F_SPEND='public.pi_supply_spend(text,timestamptz)'; F_STATE='public.pi_supply_state(text)'; F_PRESTATE='public.pi_supply_state_pre_studio(text)'
F_COUNTS='public.pi_studio_call_counts(text,timestamptz,text)'; F_CAP='public.podcast_studio_operations_cap()'
KEYS="read_only ma_count ma_has_o3 ma_has_o8 ma_md5_without_o8 sm_md5 pi_paid_operations open_operations pi_data_md5 m000 m120 m130 m140
 studio_tables studio_rows studio_open studio_rls studio_policies studio_access studio_cols_md5 studio_cons_md5 cap_trigger
 fn_spend fn_state fn_prestate fn_counts fn_cap exec_spend exec_state exec_prestate exec_counts exec_cap
 other_functions_md5 triggers_md5 tables_md5 supply_md5 spend_md5 auth_rows auth_md5 podcast_busy podcast_md5 jobs_active jobs_md5 long_xacts end"

# function facts: prosrc md5 | lang | volatility | secdef | config | owner   ('absent' if the function does not exist)
fnq() { echo "select '$1', coalesce((select md5(p.prosrc) || '|' || l.lanname || '|' || p.provolatile::text || '|' || p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || pg_get_userbyid(p.proowner) from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = to_regprocedure('$2')), 'absent');"
  echo "select '$3', coalesce((select string_agg(r || '=' || has_function_privilege(r, to_regprocedure('$2'), 'EXECUTE'), ',' order by r) from unnest(array['anon','authenticated','service_role']) r where to_regprocedure('$2') is not null), 'absent');"; }
snap() {
  { printf 'begin transaction read only;\nset local search_path = %s;\n' "''"; cat <<SQL; fnq fn_spend "$F_SPEND" exec_spend; fnq fn_state "$F_STATE" exec_state; fnq fn_prestate "$F_PRESTATE" exec_prestate; fnq fn_counts "$F_COUNTS" exec_counts; fnq fn_cap "$F_CAP" exec_cap; cat <<SQL2; printf 'rollback;\n'; } | "$PSQL" "$1" -X -qAt -F '|' -v ON_ERROR_STOP=1 > "$2"
select 'read_only', current_setting('transaction_read_only');
select 'ma_count', count(*) from public._migrations_applied;
select 'ma_has_o3', count(*) from public._migrations_applied where name = '$O3NAME';
select 'ma_has_o8', count(*) from public._migrations_applied where name = '$NAME';
select 'ma_md5_without_o8', md5(coalesce(string_agg(name, ',' order by name), '')) from public._migrations_applied where name <> '$NAME';
select 'sm_md5', md5(coalesce(string_agg(version || ':' || coalesce(name, ''), ',' order by version), '')) from supabase_migrations.schema_migrations;
select 'pi_paid_operations', count(*) from public.pi_paid_operations;
select 'open_operations', count(*) from public.pi_paid_operations where status in ('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED');
select 'pi_data_md5', md5(string_agg(c.relname || ':' || (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(t::text, ''|'' order by t::text), '''')) h from public.%I t', c.relname), false, true, '')))[1]::text, ',' order by c.relname))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'pi\_%';
select 'm000', coalesce(bool_or(pg_get_functiondef(p.oid) like '%authorization missing%'), false) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'pi_submit_with_supply';
select 'm120', coalesce(bool_or(pg_get_functiondef(p.oid) like '%r.authorization_ref = b.authorization_ref%'), false) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'pi_documentary_resume_requires_budget';
select 'm130', coalesce(bool_or(pg_get_functiondef(p.oid) like '%status <> ''RESERVED''%'), false) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'pi_open_spend_authorization';
select 'm140', to_regprocedure('public.pi_supply_state_pre_studio(text)') is not null;
select 'studio_tables', (to_regclass('public.podcast_studio_episodes') is not null)::int + (to_regclass('public.podcast_studio_operations') is not null)::int;
select 'studio_rows', case when to_regclass('public.podcast_studio_episodes') is null or to_regclass('public.podcast_studio_operations') is null then 'absent'
  else (xpath('/row/n/text()', query_to_xml('select (select count(*) from public.podcast_studio_episodes) || '':'' || (select count(*) from public.podcast_studio_operations) n', false, true, '')))[1]::text end;
select 'studio_open', case when to_regclass('public.podcast_studio_operations') is null then 'absent'
  else (xpath('/row/n/text()', query_to_xml('select count(*) n from public.podcast_studio_operations where state in (''reserved'',''uncertain'')', false, true, '')))[1]::text end;
select 'studio_rls', coalesce((select string_agg(c.relname || '=' || c.relrowsecurity, ',' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('podcast_studio_episodes','podcast_studio_operations')), 'absent');
select 'studio_policies', coalesce((select string_agg(tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, '+') || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ',' order by tablename, policyname) from pg_policies where schemaname = 'public' and tablename in ('podcast_studio_episodes','podcast_studio_operations')), 'absent');
select 'studio_access', coalesce((select string_agg(t || '.' || r || '=' || has_table_privilege(r, 'public.' || t, 'SELECT')::int || has_table_privilege(r, 'public.' || t, 'INSERT')::int || has_table_privilege(r, 'public.' || t, 'UPDATE')::int || has_table_privilege(r, 'public.' || t, 'DELETE')::int, ',' order by t, r)
  from unnest(array['podcast_studio_episodes','podcast_studio_operations']) t, unnest(array['anon','authenticated','service_role']) r where to_regclass('public.' || t) is not null), 'absent');
select 'studio_cols_md5', coalesce((select md5(string_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' order by c.relname, a.attnum))
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relname in ('podcast_studio_episodes','podcast_studio_operations') and a.attnum > 0 and not a.attisdropped), 'absent');
select 'studio_cons_md5', coalesce((select md5(string_agg(x, ',' order by x)) from (select conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) x from pg_constraint where conrelid in (select oid from pg_class where relname in ('podcast_studio_episodes','podcast_studio_operations') and relnamespace = 'public'::regnamespace)
  union all select indexrelid::regclass::text || ':' || pg_get_indexdef(indexrelid) from pg_index where indrelid in (select oid from pg_class where relname in ('podcast_studio_episodes','podcast_studio_operations') and relnamespace = 'public'::regnamespace)) s), 'absent');
select 'cap_trigger', coalesce((select string_agg(tgname || ':' || tgenabled::text || ':' || md5(pg_get_triggerdef(oid)), ',' order by tgname) from pg_trigger where not tgisinternal and tgrelid = to_regclass('public.podcast_studio_operations')), 'absent');
SQL
select 'other_functions_md5', md5(string_agg(p.oid::regprocedure::text || '=' || md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind in ('f','p')
  and p.proname not in ('pi_supply_spend','pi_supply_state','pi_supply_state_pre_studio','pi_studio_call_counts','podcast_studio_operations_cap');
select 'triggers_md5', md5(coalesce(string_agg(tgrelid::regclass::text || '.' || tgname || ':' || tgenabled::text || ':' || md5(pg_get_triggerdef(oid)), ',' order by 1), ''))
  from pg_trigger where not tgisinternal and tgrelid is distinct from to_regclass('public.podcast_studio_operations');
select 'tables_md5', md5(string_agg(c.relname || ':' || c.relkind::text || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity, ',' order by c.relname))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v','m','p') and c.relname not in ('podcast_studio_episodes','podcast_studio_operations');
select 'supply_md5', md5(coalesce(string_agg(provider || '=' || (public.pi_supply_state(provider) - 'studioActiveCalls' - 'studioTodayCalls')::text, '|' order by provider), '')) from public.pi_supply_policies;
select 'spend_md5', md5(coalesce(string_agg(provider || '=' || public.pi_supply_spend(provider, date_trunc('day', now()))::text, '|' order by provider), '') || '|*=' || public.pi_supply_spend(null, date_trunc('day', now()))::text) from public.pi_supply_policies;
select 'auth_rows', count(*) from public.pi_spend_authorizations;
select 'auth_md5', md5(coalesce(string_agg(a::text, '|' order by a::text), '')) from public.pi_spend_authorizations a;
select 'podcast_busy', count(*) from public.podcast_episodes where video_status in ('queued','running','scheduled');
select 'podcast_md5', md5(coalesce(string_agg(id::text || ':' || coalesce(status, '') || ':' || coalesce(video_status, '') || ':' || coalesce(updated_at::text, ''), ',' order by id), '')) from public.podcast_episodes;
select 'jobs_active', count(*) from public.documentary_script_jobs where status in ('queued','running');
select 'jobs_md5', md5(coalesce(string_agg(id::text || ':' || status || ':' || retry_count || ':' || coalesce(updated_at::text, ''), ',' order by id), '')) from public.documentary_script_jobs;
select 'long_xacts', count(*) from pg_stat_activity where pid <> pg_backend_pid() and xact_start < now() - interval '60 seconds' and state <> 'idle';
select 'end', 'ok';
SQL2
}

get() { awk -F'|' -v k="$2" '$1 == k { sub(/^[^|]*[|]/, ""); print; exit }' "$1"; }
fails=0
chk() { if [ "$2" = "$3" ]; then echo "PASS O8[$1] $4 = $2"; else echo "FAIL O8[$1] $4 = $2 (expected $3)"; fails=$((fails+1)); fi; }
same_as() { chk "$1" "$(get "$3" "$4")" "$(get "$2" "$4")" "$4 unchanged"; }
complete() { local miss="" dup; for k in $KEYS; do [ -n "$(get "$2" "$k")" ] || miss="$miss $k"; done
  dup=$(cut -d'|' -f1 "$2" 2>/dev/null | sort | uniq -d | paste -sd' ')
  [ -s "$2" ] && [ -z "$miss" ] && [ -z "$dup" ] && [ "$(get "$2" read_only)" = on ] && [ "$(get "$2" end)" = ok ] && echo "PASS O8[$1] snapshot complete ($(wc -l < "$2") facts, no duplicate key)" \
    || { echo "FAIL O8[$1] snapshot $2 incomplete, duplicated or not read-only (missing:${miss:- none}; duplicated:${dup:- none})"; fails=$((fails+1))
         echo "INFO stopped: no other check runs on a broken snapshot"; echo "RESULT o8 ${CMD}: $fails FAIL"; exit 1; }; }
hashes() { [ "$(sha256sum < "$MIG" | cut -d' ' -f1)" = $SHA_MIG ] && cmp -s "$MIG" "$R/supabase/proposals/$NAME" && [ "$(sha256sum < "$RB" | cut -d' ' -f1)" = $SHA_RB ] \
  && [ "$(sha256sum < "$CT" | cut -d' ' -f1)" = "$SHA_CT" ] && [ "$(sha256sum < "$PRE_FILE" | cut -d' ' -f1)" = "$SHA_PRE" ] \
  || { echo "FAIL O8 sha256 of the migration / rollback / contingency / 20261005150229 differs from the audited one"; exit 1; }; }
srcmd5() { python3 -I -c 'import re,sys,hashlib; s=open(sys.argv[1]).read(); m=[x for x in re.finditer(r"create (?:or replace )?function (public\.\w+)\(.*?as \$\$(.*?)\$\$", s, re.S | re.I) if x.group(1) == sys.argv[2]]; print(hashlib.md5(m[-1].group(2).encode()).hexdigest() if m else "none")' "$1" "$2"; }
refs() { hashes
  [ "$(srcmd5 "$PRE_FILE" public.pi_supply_spend)$(srcmd5 "$RB" public.pi_supply_spend)$(srcmd5 "$PRE_FILE" public.pi_supply_state)" = "$SPEND_PRE$SPEND_PRE$STATE_PRE" ] \
  && [ "$(srcmd5 "$MIG" public.pi_supply_spend)|$(srcmd5 "$MIG" public.pi_supply_state)|$(srcmd5 "$MIG" public.pi_studio_call_counts)|$(srcmd5 "$MIG" public.podcast_studio_operations_cap)" = "$SPEND_POST|$STATE_POST|$COUNTS_POST|$CAP_POST" ] \
  || { echo "FAIL O8 audited body references do not match the sha-pinned SQL files"; exit 1; }; }
NOEXEC='anon=false,authenticated=false,service_role=true'
# fn facts: src|lang|volatility|secdef|config|owner
pre_objects() {
  chk "$1" "$(get $2 fn_spend | cut -d'|' -f1-5)|$(get $2 exec_spend)" "$SPEND_PRE|sql|v|false|search_path=\"\"|$NOEXEC" "pi_supply_spend body (prosrc md5 == 20261005150229) | lang | volatility | secdef | config | EXECUTE"
  chk "$1" "$(get $2 fn_state | cut -d'|' -f1-5)|$(get $2 exec_state)" "$STATE_PRE|plpgsql|v|false|search_path=\"\"|$NOEXEC" "pi_supply_state body (== 20261005150229) | lang | volatility | secdef | config | EXECUTE"
  chk "$1" "$(get $2 fn_prestate)|$(get $2 fn_counts)|$(get $2 fn_cap)|$(get $2 studio_tables)|$(get $2 cap_trigger)" "absent|absent|absent|0|absent" "140000 objects absent (pre_studio | call_counts | cap fn | studio tables | cap trigger)"; }
post_objects() {
  chk "$1" "$(get $2 fn_spend | cut -d'|' -f1-5)|$(get $2 exec_spend)" "$SPEND_POST|sql|v|false|search_path=\"\"|$NOEXEC" "pi_supply_spend body (prosrc md5 == 140000) | lang | volatility | secdef | config | EXECUTE"
  chk "$1" "$(get $2 fn_state | cut -d'|' -f1-5)|$(get $2 exec_state)" "$STATE_POST|plpgsql|v|false|search_path=\"\"|$NOEXEC" "pi_supply_state wrapper body (== 140000) | lang | volatility | secdef | config | EXECUTE"
  chk "$1" "$(get $2 fn_prestate | cut -d'|' -f1-5)|$(get $2 exec_prestate)" "$STATE_PRE|plpgsql|v|false|search_path=\"\"|$NOEXEC" "pi_supply_state_pre_studio = the original body (== 20261005150229) | EXECUTE"
  chk "$1" "$(get $2 fn_counts | cut -d'|' -f1-5)|$(get $2 exec_counts)" "$COUNTS_POST|sql|s|false|search_path=\"\"|$NOEXEC" "pi_studio_call_counts body (== 140000) | stable | EXECUTE"
  chk "$1" "$(get $2 fn_cap | cut -d'|' -f1-5)|$(get $2 exec_cap | cut -d, -f1-2)" "$CAP_POST|plpgsql|v|true|search_path=\"\"|anon=false,authenticated=false" "podcast_studio_operations_cap body (== 140000) | security definer | not executable by anon/authenticated"
  chk "$1" "$(get $2 studio_tables)|$(get $2 studio_rls)" "2|podcast_studio_episodes=true,podcast_studio_operations=true" "studio tables | RLS enabled on both"
  chk "$1" "$(get $2 studio_policies | tr ',' '\n' | cut -d: -f1-4 | paste -sd,)" "podcast_studio_episodes:podcast_studio_episodes_owner_read:SELECT:authenticated,podcast_studio_operations:podcast_studio_operations_owner_read:SELECT:authenticated" "exactly one owner-read SELECT policy per table, for authenticated"
  chk "$1" "$(get $2 studio_policies | tr ',' '\n' | cut -d: -f5 | sort -u | paste -sd,)" "(user_id = auth.uid())" "policy predicate: user_id = auth.uid()"
  chk "$1" "$(get $2 studio_access | tr ',' '\n' | awk -F= '{split($1,a,"."); print a[2] "=" substr($2,2,3)}' | sort -u | paste -sd,)" "anon=000,authenticated=000,service_role=111" "table writes (INSERT,UPDATE,DELETE) on both studio tables: none for anon/authenticated, all for service_role"
  chk "$1" "$(get $2 cap_trigger | cut -d: -f1-2)" "podcast_studio_operations_cap:O" "cap trigger present and enabled"; }
done_state() {
  chk "$1" "$(get $2 ma_has_o3)|$(get $2 ma_has_o8)" "1|1" "130000 | 140000 registered"
  chk "$1" "$(get $2 m000)$(get $2 m120)$(get $2 m130)$(get $2 m140)" "tttt" "markers 000000/120000/130000/140000"
  chk "$1" "$(get $2 studio_rows)|$(get $2 studio_open)" "0:0|0" "studio ledger empty right after O8 (episodes:operations | open)"
  post_objects "$1" "$2"; }
DATA_KEYS="pi_paid_operations open_operations pi_data_md5 supply_md5 spend_md5 auth_rows auth_md5 podcast_busy podcast_md5 jobs_active jobs_md5"

CMD=${1:-}
case "${1:-}" in
  snap) snap "$2" "$3" || { echo "FAIL O8[snap] read-only snapshot query failed"; exit 1; }; complete snap "$3";;
  pre)
    refs; s=$2; complete pre $s
    chk pre "$(get $s ma_has_o3)|$(get $s ma_has_o8)" "1|0" "130000 registered | 140000 not registered"
    chk pre "$(get $s m000)$(get $s m120)$(get $s m130)$(get $s m140)" "tttf" "markers 000000/120000/130000/140000"
    pre_objects pre $s
    chk pre "$(get $s podcast_busy)|$(get $s jobs_active)|$(get $s long_xacts)" "0|0|0" "podcast queued/running/scheduled | documentary jobs active | non-idle xacts > 60 s";;
  done) refs; complete done "$2"; done_state done "$2";;
  post)
    refs; p=$2; s=$3; complete post-pre $p; complete post $s; done_state post $s
    chk post "$(get $s ma_count)" "$(( $(get $p ma_count) + 1 ))" "_migrations_applied rows = pre + 1"
    for k in ma_md5_without_o8 sm_md5 $DATA_KEYS other_functions_md5 triggers_md5 tables_md5; do same_as post $p $s $k; done;;
  same)
    refs; p=$2; s=$3; complete restored-pre $p; complete restored $s; pre_objects restored $s
    for k in ma_count ma_has_o3 ma_has_o8 ma_md5_without_o8 sm_md5 m000 m120 m130 m140 studio_tables studio_rows fn_spend fn_state fn_prestate fn_counts fn_cap \
             exec_spend exec_state other_functions_md5 triggers_md5 tables_md5 $DATA_KEYS; do same_as restored $p $s $k; done;;
  verdict)
    out=$(bash "$0" same "$2" "$3"); f=$(printf '%s\n' "$out" | grep '^FAIL' || true)
    if [ -z "$f" ]; then echo "O8 VERDICT: REVERTIDO (exact pre-O8 state)"; exit 0; fi
    printf '%s\n' "$f"
    other=$(printf '%s\n' "$f" | grep -vE "^FAIL O8\[restored\] ($(echo $DATA_KEYS | tr ' ' '|')) unchanged" || true)
    if [ -z "$other" ]; then echo "O8 VERDICT: BLOQUEADO (O8 undone exactly; concurrent changes in data left as they are)"; exit 3; fi
    echo "O8 VERDICT: FALLIDO (state is not the pre-O8 state)"; exit 1;;
  complete-only) complete check "$2";;
  classify)
    refs; s=$2; c=INDETERMINADO
    if bash "$0" complete-only "$s" >/dev/null; then
      po=$( (pre_objects x "$s" >/dev/null; echo $fails) ); fails=0; dn=$( (post_objects x "$s" >/dev/null; echo $fails) ); fails=0
      has=$(get $s ma_has_o8)
      if [ "$(get $s ma_has_o3)" != 1 ] || [ "$(get $s m130)" != t ]; then c=INDETERMINADO
      elif [ "$po" = 0 ] && [ "$has" = 0 ]; then c=PRE
      elif [ "$dn" = 0 ] && [ "$has" = 1 ]; then c=COMPLETADO
      elif [ "$dn" = 0 ] && [ "$has" = 0 ]; then c=PARCIAL_SIN_REGISTRO
      elif [ "$po" = 0 ] && [ "$has" = 1 ]; then c=PARCIAL_SOLO_REGISTRO
      fi
    fi
    echo "O8 STATE: $c"; [ $c = PRE ] || [ $c = COMPLETADO ];;
  o3run)
    j=$(curl -fsS -H "Authorization: Bearer ${GITHUB_TOKEN:?}" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/${GITHUB_REPOSITORY:?}/actions/runs/$2") || { echo "FAIL O8[o3run] cannot read run $2"; exit 1; }
    got=$(printf '%s' "$j" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print("|".join(str(d.get(k)) for k in ("id","path","event","head_sha","status","conclusion")))')
    chk o3run "$got" "$2|.github/workflows/o3-ejecucion-unica.yml|workflow_dispatch|$O3_SHA|completed|success" "O3 run | workflow | event | SHA | status | conclusion";;
  bind)
    head=$(git -C "$R" rev-parse HEAD); dirty=$(git -C "$R" status --porcelain | wc -l)
    chk bind "$head|${GITHUB_SHA:-$head}|$dirty" "$2|$2|0" "checked-out commit | GITHUB_SHA | uncommitted changes";;
  probe)
    # same probe as o3.sh: connectResolved() returns { client } (calling .query on the wrapper was the 40453138784 FAIL)
    out=$(cd "$R" && npx tsx -e 'import { connectResolved } from "./scripts/lib/supabase-db"; (async () => { const { client } = await connectResolved(); const r = await client.query("begin transaction read only; show lock_timeout; show statement_timeout; show transaction_read_only; rollback;"); console.log((r as any).filter((x: any) => x.rows?.length).map((x: any) => Object.values(x.rows[0])[0]).join(",")); await client.end(); })().catch((e) => { console.error(e.message); process.exit(1); })' 2>&1 | tail -1)
    echo "INFO probe: lock_timeout,statement_timeout,transaction_read_only on the tool's own connection = $out"
    chk probe "$(echo "$out" | cut -d, -f2-)" "${EXPECT_STATEMENT_TIMEOUT:-2min},on" "statement_timeout,read-only probe";;
  apply)
    out=$(cd "$R" && npx tsx scripts/apply-supabase-migration.ts "$NAME" 2>&1); rc=$?; printf '%s\n' "$out" | tail -n 6
    chk apply "$rc|$(printf '%s\n' "$out" | grep -c "Resumen: 1 aplicada(s) \[$NAME\], 0 reconciliada(s)")" "0|1" "tool exit | exactly 1 applied, 0 reconciled";;
  contingency)
    # step 1: guard + audited rollback in ONE transaction: refused (nothing dropped) if any studio row exists
    "$PSQL" "$2" -X -v ON_ERROR_STOP=1 --single-transaction \
      -c "do \$g\$ begin if to_regprocedure('public.pi_supply_state_pre_studio(text)') is null then raise exception 'O8 CONTINGENCIA: 140000 not present (pi_supply_state_pre_studio missing): the rollback would drop pi_supply_state, nothing done'; end if; if to_regclass('public.podcast_studio_operations') is not null and exists (select 1 from public.podcast_studio_operations) then raise exception 'O8 CONTINGENCIA: studio ledger not empty, nothing dropped'; end if; if to_regclass('public.podcast_studio_episodes') is not null and exists (select 1 from public.podcast_studio_episodes) then raise exception 'O8 CONTINGENCIA: studio episodes exist, nothing dropped'; end if; end \$g\$" \
      -f "$RB"; rc=$?
    chk contingency $rc 0 "step 1: guard (140000 present, 0 studio rows) + audited 140000 rollback, one transaction"
    if [ $rc != 0 ]; then echo "FAIL O8[contingency] step 1 failed: STOP, step 2 NOT run (state must be classified and reported)"; fails=$((fails+1)); echo "RESULT o8 contingency: $fails FAIL"; exit 1; fi
    "$PSQL" "$2" -X -v ON_ERROR_STOP=1 -f "$CT"; chk contingency $? 0 "step 2: remove the 140000 registry row";;
  *) echo "usage: o8.sh snap|pre|done|post|same|verdict|classify|o3run|bind|probe|apply|contingency …"; exit 2;;
esac
echo "RESULT o8 ${1}: $fails FAIL"
[ $fails = 0 ]
