/** Owner-authorised: apply the Podcast V3 studio migration (additive) and verify it. Requires CONFIRM=MIGRATE-STUDIO-V3. */
import { readFileSync } from "node:fs";
async function main() {
  if (process.env.CONFIRM !== "MIGRATE-STUDIO-V3") throw Error("confirmation missing");
  const { connectResolved } = await import("./lib/supabase-db");
  const { client: c } = await connectResolved();
  const q = async (sql: string) => (await c.query(sql)).rows;
  try {
    const before = await q("select count(*)::int n from public.podcast_episodes");
    const sql = readFileSync("supabase/proposals/20261023120000_podcast_v3_studio.sql", "utf8");
    await c.query("begin"); await c.query(sql); await c.query("commit");
    const after = await q("select count(*)::int n from public.podcast_episodes");
    console.log("MIGRATE", JSON.stringify({ applied: true, podcastEpisodesBefore: before[0].n, podcastEpisodesAfter: after[0].n,
      rls: await q("select relname, relrowsecurity from pg_class where relname like 'podcast_studio_%' and relkind='r' order by 1"),
      policies: await q("select tablename, cmd from pg_policies where tablename like 'podcast_studio_%' order by 1"),
      writeGrants: await q("select table_name, grantee, string_agg(privilege_type, ',') p from information_schema.role_table_grants where table_name like 'podcast_studio_%' and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE') group by 1,2") }));
    await c.query("notify pgrst, 'reload schema'");
  } catch (e) { await c.query("rollback").catch(() => {}); console.log("STOP", String(e).slice(0, 300)); process.exitCode = 1; }
  finally { await c.end(); }
}
main().catch((e) => { console.log("FAILED", String(e).slice(0, 300)); process.exitCode = 1; });
