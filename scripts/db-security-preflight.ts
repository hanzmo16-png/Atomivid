/**
 * READ-ONLY production preflight for the security hardening mission. Runs inside a
 * `read only` transaction: it cannot create, alter or write anything. Prints catalog facts
 * (grants, view options, function search_path, RLS, registry rows, row counts) and never a
 * secret: connection strings/hosts are not echoed. Same connection resolution as the migration
 * runner (scripts/lib/supabase-db.ts), so the reported role IS the runner's role.
 */
export {};

const TABLES = ["video_requests", "generation_costs", "subscriptions", "avatars", "user_voices", "tts_jobs"];
const FUNCTIONS = ["enforce_tts_monthly_limit", "enforce_user_voice_limits", "pi_reject_mutation", "pi_paid_operation_forward_only", "fc_append_only", "yt_snapshot_final"];
const INTERNAL = ["pi_paid_operations", "pi_telemetry_events", "pi_policy_versions", "pi_policy_history", "pi_memory_snapshots", "pi_project_pins", "pi_asset_transitions", "pi_provider_accounts", "pi_capacity_snapshots", "fc_inspections", "fc_issues", "fc_repairs", "fc_qa_decisions", "fc_master_metrics", "yt_oauth_connections", "yt_pending_connections", "delivery_assets", "_migrations_applied"];

async function main() {
  const { connectResolved } = await import("./lib/supabase-db");
  const { client, connection } = await connectResolved();
  console.log(`[preflight] connected via ${connection.source} (host/credentials never printed)`);
  try {
    await client.query("begin transaction read only");
    const one = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
    console.log("== role ==", JSON.stringify((await one("select current_user, session_user, (select rolbypassrls from pg_roles where rolname = current_user) as bypass_rls, (select rolsuper from pg_roles where rolname = current_user) as superuser"))[0]));
    console.log("== registry (_migrations_applied) ==");
    for (const r of await one("select name, applied_at from public._migrations_applied order by name")) console.log(`  ${r.name}  ${new Date(r.applied_at).toISOString()}`);
    console.log("== registry table: rls / grants / owner ==", JSON.stringify(await one("select c.relrowsecurity as rls, c.relforcerowsecurity as force_rls, pg_get_userbyid(c.relowner) as owner, c.relacl::text as acl from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = '_migrations_applied'")));
    console.log("== registry grants (information_schema) ==", JSON.stringify(await one("select grantee, string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where table_schema = 'public' and table_name = '_migrations_applied' group by grantee order by grantee")));
    console.log("== row counts ==");
    for (const t of TABLES) { const exists = (await one("select to_regclass($1) as r", [`public.${t}`]))[0].r; console.log(`  ${t}: ${exists ? (await one(`select count(*)::int as n from public.${t}`))[0].n : "TABLE MISSING"}`); }
    console.log("== 0023-0028 objects present ==", JSON.stringify(await one("select relname, relkind, relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and (relname like 'pi\\_%' or relname like 'fc\\_%' or relname like 'yt\\_%' or relname = 'delivery_assets') order by relname")));
    console.log("== view yt_video_experiment ==", JSON.stringify(await one("select pg_get_userbyid(c.relowner) as owner, c.reloptions, c.relacl::text as acl, pg_get_viewdef(c.oid, true) as definition from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'yt_video_experiment' and c.relkind = 'v'")));
    console.log("== view grants ==", JSON.stringify(await one("select grantee, string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where table_schema = 'public' and table_name = 'yt_video_experiment' group by grantee order by grantee")));
    console.log("== view dependencies ==", JSON.stringify(await one("select distinct d.refobjid::regclass::text as depends_on from pg_depend d join pg_rewrite r on r.oid = d.objid where r.ev_class = 'public.yt_video_experiment'::regclass and d.refobjid <> 'public.yt_video_experiment'::regclass and d.classid = 'pg_rewrite'::regclass")));
    console.log("== functions: search_path / security ==", JSON.stringify(await one("select p.proname, p.prosecdef as security_definer, p.proconfig, pg_get_userbyid(p.proowner) as owner from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any($1) order by p.proname", [FUNCTIONS])));
    console.log("== triggers on those functions ==", JSON.stringify(await one("select t.tgname, t.tgrelid::regclass::text as table_name, p.proname, t.tgenabled from pg_trigger t join pg_proc p on p.oid = t.tgfoid where not t.tgisinternal and p.proname = any($1) order by table_name, t.tgname", [FUNCTIONS])));
    console.log("== internal tables: rls / policies / client grants ==", JSON.stringify(await one("select c.relname, c.relrowsecurity as rls, (select count(*) from pg_policy p where p.polrelid = c.oid) as policies, (select string_agg(distinct grantee || ':' || privilege_type, ',') from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name = c.relname and g.grantee in ('anon','authenticated')) as client_grants from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any($1) order by c.relname", [INTERNAL])));
    console.log("== default privileges in public ==", JSON.stringify(await one("select pg_get_userbyid(defaclrole) as role, defaclobjtype as objtype, defaclacl::text as acl from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace where n.nspname = 'public'")));
    console.log("== backup/PITR: not queryable from SQL (Supabase dashboard / Management API only) ==");
    await client.query("rollback");
    console.log("[preflight] read-only transaction rolled back; nothing written");
  } finally { await client.end(); }
}
main().catch((e) => { console.error(`[preflight] BLOCKED: ${e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/g, "<connection>") : e}`); process.exit(1); });
