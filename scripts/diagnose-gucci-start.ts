/** Read-only: what the owner's real "Iniciar producción" click left behind.
 * No writes, no provider calls. pi_supply_state is a read-only SQL function. */
import { createClient } from "@supabase/supabase-js";
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs } = await db.from("documentary_script_jobs").select("id,request_id");
  const requestId = jobs!.find(j => j.id.startsWith("7b7d4b60"))!.request_id;
  const { data: r } = await db.from("video_requests").select("status,render_attempts,render_started_at,render_worker,progress_stage,long_form_stage,supply_wait_started_at,supply_not_before,error_message,long_form_confirmed_at,video_path").eq("id", requestId).single();
  console.log("REQUEST", JSON.stringify({ ...r, long_form_confirmed_at: !!r?.long_form_confirmed_at, video_path: !!r?.video_path }));
  const { data: res } = await db.from("pi_supply_job_reservations").select("provider,render_attempt,status,reserved_units,reserved_usd,created_at").eq("project_id", requestId);
  console.log("JOB_RESERVATIONS", JSON.stringify(res));
  const since = new Date(Date.now() - 6 * 3600e3).toISOString();
  const { data: ops } = await db.from("pi_paid_operations").select("provider,method,status,reserved_usd,committed_usd,created_at").eq("project_id", requestId).gte("created_at", since);
  console.log("LEDGER_FOR_REQUEST_6H", JSON.stringify(ops));
  const { data: allOps } = await db.from("pi_paid_operations").select("provider,method,status,committed_usd,created_at").gte("created_at", new Date(Date.now() - 3 * 3600e3).toISOString());
  console.log("LEDGER_ALL_3H", JSON.stringify(allOps));
  for (const provider of ["elevenlabs", "openai", "runway"]) {
    const { data: state, error } = await db.rpc("pi_supply_state", { p_provider: provider });
    const { data: snap } = await db.from("pi_capacity_snapshots").select("available,reliability,status,checked_at").eq("provider", provider).order("checked_at", { ascending: false }).limit(1);
    console.log("SUPPLY", JSON.stringify({ provider, error: error?.message ?? null, level: state?.level, reason: state?.reason, free: state?.free, snapshot: snap?.[0] ?? null }));
  }
  const { data: alerts } = await db.from("pi_supply_alerts").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(10);
  console.log("ALERTS_6H", JSON.stringify(alerts));
}
main().catch(e => { console.error(e instanceof Error ? e.message : "failed"); process.exitCode = 1; });
