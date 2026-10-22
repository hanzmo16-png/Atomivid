import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { enqueueScriptJob, runScriptJobStep } from "@/lib/video/long-form/script-jobs";
const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "pilot-owner@local.test", email_confirmed_at: "2026-01-01T00:00:00Z" };
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const row = async (id: string) => (await s.from("documentary_script_jobs").select("status,stage,resubmit_allowance,retry_count,updated_at,failure_kind").eq("id", id).single()).data;
(async () => {
  const job = await enqueueScriptJob(s, OWNER, { topic: "Misterios del océano profundo — prueba de interrupción", durationMinutes: "9", language: "es", sources: "", openQuestions: "" }, s);
  // 1) An invocation claims the job and dies (Vercel stopped it): no finish, no release.
  const { data: claim } = await s.rpc("claim_documentary_script_job", { p_id: job.id, p_token: randomUUID() });
  console.log("claimed-and-died", JSON.stringify(claim), JSON.stringify(await row(job.id)));
  // 2) Fresh: the worker's next step must NOT steal it.
  console.log("fresh step ->", (await runScriptJobStep(job.id, s)).state);
  // 3) 11 minutes later (clock simulated on the row): the step recovers it itself, nobody on the page.
  await s.from("documentary_script_jobs").update({ updated_at: new Date(Date.now() - 11 * 60_000).toISOString() }).eq("id", job.id);
  let last = ""; for (let i = 0; i < 40; i++) { last = (await runScriptJobStep(job.id, s)).state; if (last !== "queued" && last !== "waiting") break; }
  console.log("after recovery ->", last, JSON.stringify(await row(job.id)));
  const { data: vr } = await s.from("documentary_script_jobs").select("request_id").eq("id", job.id).single();
  const { data: req } = await s.from("video_requests").select("status").eq("id", vr!.request_id).single();
  console.log("video request ->", req?.status);
})().catch(e => { console.error("FAILED", e); process.exit(1); });
