/**
 * Owner-authorised (2026-10-23 21:09): apply supabase/proposals/20261024000000_spend_authorizations.sql (PR #198) in
 * production. Requires CONFIRM=MIGRATE-198. Before: snapshot of the functions it replaces (definitions + ACL), counts
 * of protected tables and no paid call in flight. After: security contract (SECURITY DEFINER, search_path='', ACL),
 * privileges per role, tables untouched, wrapper executable. Any failure rolls back the whole transaction.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
async function main() {
  if (process.env.CONFIRM !== "MIGRATE-198") throw Error("confirmation missing");
  const { connectResolved } = await import("./lib/supabase-db");
  const { client: c } = await connectResolved();
  const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;
  const counts = async () => (await q(`select (select count(*) from public.podcast_episodes)::int episodes, (select count(*) from public.documentary_script_jobs)::int jobs,
    (select count(*) from public.pi_paid_operations)::int ops, (select count(*) from public.pi_recovery_budgets)::int budgets,
    (select md5(coalesce(string_agg(id::text||status||coalesce(audio_path,''), ',' order by id), '')) from public.podcast_episodes) episodes_md5`))[0];
  const fn = (name: string) => q(`select p.oid::regprocedure::text sig, p.prosecdef, p.proconfig, p.proacl::text acl,
    has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') authenticated, has_function_privilege('service_role', p.oid, 'EXECUTE') service_role
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [name]);
  try {
    const already = await q("select to_regclass('public.pi_spend_authorizations') t");
    if (already[0].t) { console.log("STOP", JSON.stringify({ reason: "pi_spend_authorizations already exists: migration not re-applied", fn: await fn("pi_submit_with_supply") })); return; }
    const inflight = await q("select count(*)::int n from public.pi_paid_operations where status in ('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED') and updated_at > now() - interval '30 minutes'");
    if (inflight[0].n > 0) { console.log("STOP", JSON.stringify({ reason: "paid calls in flight; retry later", inflight: inflight[0].n })); return; }
    const before = await counts();
    const backup = (await q("select pg_get_functiondef('public.pi_submit_with_supply(text,numeric)'::regprocedure) d"))[0].d as string;
    console.log("MIGRATE", JSON.stringify({ phase: "before", counts: before, pi_submit_with_supply: await fn("pi_submit_with_supply"), backupSha256: createHash("sha256").update(backup).digest("hex"), backupBytes: backup.length }));
    const sql = readFileSync("supabase/proposals/20261024000000_spend_authorizations.sql", "utf8");
    console.log("MIGRATE", JSON.stringify({ phase: "sql", sha256: createHash("sha256").update(sql).digest("hex") }));
    await c.query(sql); // the file has its own begin/commit
    const after = await counts();
    const report = { phase: "after", counts: after, unchanged: JSON.stringify(before) === JSON.stringify(after),
      wrapper: await fn("pi_submit_with_supply"), preAuthz: await fn("pi_submit_with_supply_pre_authz"), open: await fn("pi_open_spend_authorization"),
      usage: await fn("pi_spend_authorization_usage"), resumeAuth: await fn("pi_recovery_resume_authorization"),
      table: await q("select relrowsecurity rls, has_table_privilege('anon','public.pi_spend_authorizations','SELECT') anon_select, has_table_privilege('authenticated','public.pi_spend_authorizations','SELECT') auth_select from pg_class where oid = 'public.pi_spend_authorizations'::regclass"),
      trigger: await q("select tgname from pg_trigger where tgrelid = 'public.documentary_script_jobs'::regclass and tgname = 'pi_documentary_resume_requires_budget'"),
      noopCall: await (async () => { try { await c.query("begin"); await c.query("set local role service_role"); const r = (await c.query("select public.pi_submit_with_supply('ops-nonexistent-key-198', null) r")).rows[0].r; await c.query("rollback"); return r; } catch (e) { await c.query("rollback").catch(() => {}); return `error ${String(e).slice(0, 160)}`; } })() };
    console.log("MIGRATE", JSON.stringify(report));
    await c.query("notify pgrst, 'reload schema'");
  } catch (e) { await c.query("rollback").catch(() => {}); console.log("STOP", String(e).slice(0, 400)); process.exitCode = 1; }
  finally { await c.end(); }
}
main().catch((e) => { console.log("FAILED", String(e).slice(0, 300)); process.exitCode = 1; });
