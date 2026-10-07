/** Read-only: when and how the Gucci request was confirmed. Prints timestamps,
 * statuses and plan metadata only. No writes, no provider calls. */
import { createClient } from "@supabase/supabase-js";
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs } = await db.from("documentary_script_jobs").select("id,request_id,status,updated_at");
  const job = jobs!.find(j => j.id.startsWith("7b7d4b60"))!;
  const { data: r } = await db.from("video_requests").select("status,long_form_confirmed_at,long_form_stage,render_attempts,render_started_at,video_path,long_form_production_plan").eq("id", job.request_id).single();
  const plan = r!.long_form_production_plan as { version?: number; strategy?: string; estimatedCostUsd?: number; totals?: unknown } | null;
  console.log("GUCCI", JSON.stringify({ jobStatus: job.status, jobUpdated: job.updated_at, requestStatus: r!.status, confirmedAt: r!.long_form_confirmed_at, stage: r!.long_form_stage,
    renderAttempts: r!.render_attempts, renderStarted: r!.render_started_at, hasVideo: !!r!.video_path, planVersion: plan?.version ?? null, strategy: plan?.strategy ?? null, planKeys: plan ? Object.keys(plan).slice(0, 15) : [] }));
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const ops = await db.from("pi_paid_operations").select("provider,method,status,committed_usd,created_at").gte("created_at", since).order("created_at");
  console.log("PAID_OPS_24H", JSON.stringify(ops.data?.map(o => ({ provider: o.provider, method: o.method, status: o.status, usd: o.committed_usd, at: o.created_at }))));
}
main().catch(e => { console.error(e instanceof Error ? e.message : "failed"); process.exitCode = 1; });
