/**
 * FREE, READ-ONLY: replays every saved documentary script job (any status, newest first, up to REPLAY_LIMIT) against the
 * code checked out at REPLAY_REF, using only COMMITTED ledger responses (scripts/replay-documentary-job.ts). A missing
 * response is a BOUNDARY (a call the new code would have to pay for) and is reported, never made. Nothing is written.
 */
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false } });
  const { data, error } = await db.from("documentary_script_jobs").select("id,status,created_at").order("created_at", { ascending: false }).limit(Number(process.env.REPLAY_LIMIT ?? 20));
  if (error) throw Error("read");
  console.log("REPLAY_SET", JSON.stringify({ jobs: data!.length, byStatus: data!.reduce((a: Record<string, number>, j) => ((a[j.status] = (a[j.status] ?? 0) + 1), a), {}) }));
  const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.SUPPLY_GUARD_ENFORCED; delete env.VERCEL_ENV;
  // Cinematic V6 is decided per account server-side (env-dependent); the runner cannot know it, so both are replayed and
  // the variant that reuses MORE saved responses is the one production used (fingerprints include the flag).
  for (const j of data!) {
    const runs = ["true", "false"].map((cin) => {
      const r = spawnSync("npx", ["tsx", "scripts/replay-documentary-job.ts"], { env: { ...env, REPLAY_JOB: j.id, REPLAY_CINEMATIC: cin }, encoding: "utf8", timeout: 600000 });
      const lines = `${r.stdout}`.split("\n").filter((l) => /^(REPLAY|BOUNDARY) /.test(l));
      const rep = lines.find((l) => l.startsWith("REPLAY ")); let hits = -1; try { hits = JSON.parse(rep!.slice(7)).hits ?? -1; } catch { /* sin salida */ }
      return { cin, lines, hits, err: (r.stderr ?? "").slice(-160).replace(/\n/g, " "), status: r.status };
    }).sort((a, b) => b.hits - a.hits);
    const best = runs[0];
    for (const l of best.lines) console.log(l.replace(/^REPLAY /, `REPLAY [${j.status} ${j.created_at.slice(0, 10)} cinematic=${best.cin}] `));
    if (!best.lines.length) console.log(`REPLAY [${j.status}] ${j.id.slice(0, 8)} sin salida (exit ${best.status}) ${best.err}`);
  }
}
main().catch((e) => { console.log("FAILED", String(e).slice(0, 300)); process.exitCode = 1; });
