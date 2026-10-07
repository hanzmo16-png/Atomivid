/** Hard spend guard for the authorized Gucci production (MAX_SPEND_USD_4_00).
 * Polls the paid-call ledger for this request; if committed + open reservations
 * reach the stop threshold, cancels the in-progress render workflow run.
 * Read-only on data; its only action is cancelling the run. */
import { createClient } from "@supabase/supabase-js";
const STOP_USD = 3.95, OPEN = new Set(["RESERVED", "SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"]);
async function cancelRenderRuns() {
  const api = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`, h = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" };
  const runs = await (await fetch(`${api}/actions/workflows/render.yml/runs?status=in_progress&per_page=10`, { headers: h })).json() as { workflow_runs: { id: number }[] };
  for (const r of runs.workflow_runs ?? []) { await fetch(`${api}/actions/runs/${r.id}/cancel`, { method: "POST", headers: h }); console.log("CANCELLED_RENDER_RUN", r.id); }
}
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs } = await db.from("documentary_script_jobs").select("id,request_id");
  const requestId = jobs!.find(j => j.id.startsWith("7b7d4b60"))!.request_id;
  const deadline = Date.now() + 140 * 60_000;
  let sawProcessing = false;
  while (Date.now() < deadline) {
    const { data: ops } = await db.from("pi_paid_operations").select("provider,method,status,committed_usd,reserved_usd").eq("project_id", requestId).neq("method", "capacity_hold");
    const by: Record<string, { calls: number; committed: number; open: number }> = {};
    let total = 0;
    for (const o of ops ?? []) {
      const p = (by[o.provider] ??= { calls: 0, committed: 0, open: 0 });
      p.calls++;
      const c = Number(o.committed_usd ?? 0), r = OPEN.has(o.status) ? Number(o.reserved_usd ?? 0) : 0;
      p.committed += c; p.open += r; total += c + r;
    }
    const { data: row } = await db.from("video_requests").select("status,long_form_stage,render_attempts").eq("id", requestId).single();
    console.log("SPEND", JSON.stringify({ at: new Date().toISOString(), status: row?.status, stage: row?.long_form_stage, attempts: row?.render_attempts, totalUsd: +total.toFixed(4), by }));
    if (total >= STOP_USD) { console.log("STOP_THRESHOLD_REACHED"); await cancelRenderRuns(); process.exitCode = 2; return; }
    if (row?.status === "processing") sawProcessing = true;
    if (sawProcessing && row?.status !== "processing") return;
    await new Promise(r => setTimeout(r, 60_000));
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : "monitor failed"); process.exitCode = 1; });
