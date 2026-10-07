/** Read-only: which requests titled Gucci exist and whether each belongs to the
 * recovered job's owner. Hashes and booleans only; no user records are read. */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs } = await db.from("documentary_script_jobs").select("id,user_id,request_id");
  const job = jobs!.find(j => j.id.startsWith("7b7d4b60"))!;
  const { data: reqs } = await db.from("video_requests").select("id,user_id,mode,status,long_form_confirmed_at,render_attempts,created_at").ilike("topic", "%gucci%").order("created_at");
  for (const r of reqs ?? []) console.log("GUCCI_REQUEST", JSON.stringify({ id: r.id.slice(0, 8), isJobRequest: r.id === job.request_id, owner: h(r.user_id),
    ownerIsJobOwner: r.user_id === job.user_id, mode: r.mode, status: r.status, confirmed: !!r.long_form_confirmed_at, attempts: r.render_attempts, created: r.created_at }));
  const { data: gucciJobs } = await db.from("documentary_script_jobs").select("id,user_id,status").ilike("topic", "%gucci%");
  for (const j of gucciJobs ?? []) console.log("GUCCI_JOB", JSON.stringify({ id: j.id.slice(0, 8), owner: h(j.user_id), sameOwner: j.user_id === job.user_id, status: j.status }));
}
main().catch(e => { console.error(e instanceof Error ? e.message : "failed"); process.exitCode = 1; });
