/** Read-only: latest capacity snapshot per provider (no provider calls, no writes). */
import { createClient } from "@supabase/supabase-js";
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false } });
  for (const p of ["elevenlabs", "heygen", "recraft", "anthropic"]) {
    const { data, error } = await db.from("pi_capacity_snapshots").select("provider,unit,available,health,reliability,status,checked_at").eq("provider", p).order("checked_at", { ascending: false }).limit(1);
    console.log("SNAP", JSON.stringify({ p, row: data?.[0] ?? null, error: error?.message ?? null }));
  }
  const { data: pol } = await db.from("pi_supply_policies").select("provider,enabled,unit,baseline,daily_cap_usd,monthly_cap_usd").order("provider");
  console.log("POLICY", JSON.stringify(pol));
  for (const t of ["podcast_studio_episodes", "podcast_studio_operations"]) { const r = await db.from(t).select("*", { count: "exact" }).limit(1); console.log("PODCAST", JSON.stringify({ table: t, status: r.status, rows: r.count, error: r.error ? `${r.error.code} ${r.error.message}`.slice(0, 160) : null })); }
  console.log("PODCAST", JSON.stringify({ dbPassword: !!process.env.SUPABASE_DB_PASSWORD }));
  const { data: eps } = await db.from("podcast_studio_episodes").select("status,mode,created_at,cost_usd").order("created_at", { ascending: false }).limit(10);
  console.log("PODCAST", JSON.stringify({ recentEpisodes: eps }));
  const { data: ops } = await db.from("podcast_studio_operations").select("provider,op,state,reserved_usd,actual_usd,created_at").order("created_at", { ascending: false }).limit(20);
  console.log("PODCAST", JSON.stringify({ recentOps: ops }));
  // Esquema real vs propuesta (sin datos): columnas y restricciones vía pg (si hay credenciales).
  if (process.env.SUPABASE_DB_PASSWORD) {
    const { Client } = await import("pg"); const ref = process.env.SUPABASE_PROJECT_REF;
    const c = new Client({ host: process.env.SUPABASE_DB_HOST, port: Number(process.env.SUPABASE_DB_PORT || 5432), user: `postgres.${ref}`, password: process.env.SUPABASE_DB_PASSWORD, database: "postgres", ssl: { rejectUnauthorized: false } });
    try { await c.connect();
      const q = async (sql: string) => (await c.query(sql)).rows;
      console.log("PODCAST", JSON.stringify({ cols: await q("select table_name, string_agg(column_name, ',' order by ordinal_position) cols from information_schema.columns where table_schema='public' and table_name like 'podcast_studio_%' group by 1") }));
      console.log("PODCAST", JSON.stringify({ checks: await q("select conrelid::regclass::text t, count(*) n from pg_constraint where conrelid::regclass::text like '%podcast_studio_%' group by 1"), rls: await q("select relname, relrowsecurity from pg_class where relname like 'podcast_studio_%' and relkind='r'"), policies: await q("select tablename, policyname, cmd from pg_policies where tablename like 'podcast_studio_%'"), grants: await q("select table_name, grantee, string_agg(privilege_type, ',') p from information_schema.role_table_grants where table_name like 'podcast_studio_%' and grantee in ('anon','authenticated') group by 1,2") }));
      console.log("PODCAST", JSON.stringify({ migrations: await q("select version, name from supabase_migrations.schema_migrations where version like '202610%' order by version desc limit 8").catch(() => "n/a") }));
    } catch (e) { console.log("PODCAST", JSON.stringify({ pgError: String(e).slice(0, 200) })); } finally { await c.end().catch(() => {}); }
  }
}
main().catch((e) => { console.log("STOP", String(e).slice(0, 300)); });
