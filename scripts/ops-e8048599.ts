/** Owner-authorised ops for job e8048599 (2026-10-23). MODE=read is read-only. MODE=budget opens the immutable
 * recovery budget (cap from CAP_USD) — the ONLY write, and only with CONFIRM=OPEN-BUDGET-e8048599. */
import { createClient } from "@supabase/supabase-js";
import { connectResolved } from "./lib/supabase-db";
import { documentaryLedgerScopeFor } from "../src/lib/video/long-form/script-jobs";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
async function main() {
  const mode = process.env.MODE ?? "read";
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs } = await db.from("documentary_script_jobs").select("*").order("created_at", { ascending: false }).limit(50);
  const j = (jobs ?? []).find((x: any) => String(x.id).startsWith("e8048599")) as any;
  const scope = documentaryLedgerScopeFor(j)!;
  const { data: ops } = await db.from("pi_paid_operations").select("status,method,reserved_usd,committed_usd,created_at").eq("project_id", scope).order("created_at");
  log("JOB", { id: j.id, status: j.status, kind: j.failure_kind, code: j.error_code, retries: j.retry_count, runToken: !!j.run_token, updated: j.updated_at, checkpointPass: j.editorial_checkpoint?.pass });
  log("OPS", (ops ?? []).map((o: any) => `${o.created_at.slice(11, 19)} ${o.status} r=${Number(o.reserved_usd ?? 0).toFixed(4)} c=${Number(o.committed_usd ?? 0).toFixed(4)}`));
  const { client } = await connectResolved();
  try {
    const exists = (await client.query("select to_regclass('public.pi_recovery_budgets') t, to_regprocedure('public.pi_open_recovery_budget(uuid,text,numeric,text)') f")).rows[0];
    const budget = (await client.query("select cap_usd, status, cardinality(baseline_keys) baseline, authorization_ref, created_at from public.pi_recovery_budgets where job_id = $1", [j.id])).rows[0] ?? null;
    log("BUDGET_STATE", { table: !!exists.t, fn: !!exists.f, budget });
    if (mode === "budget") {
      if (process.env.CONFIRM !== "OPEN-BUDGET-e8048599") throw Error("confirmation missing");
      const cap = Number(process.env.CAP_USD); if (!(cap > 0 && cap <= 1)) throw Error("bad cap");
      const r = (await client.query("select public.pi_open_recovery_budget($1::uuid, $2, $3::numeric, $4) r", [j.id, scope, cap, process.env.AUTH_REF])).rows[0].r;
      log("BUDGET_OPEN", r);
      log("BUDGET_USAGE", (await client.query("select public.pi_recovery_budget_usage($1) u", [scope])).rows[0].u);
    }
  } finally { await client.end(); }
}
main().catch(e => { console.error("FAILED", String(e).slice(0, 300)); process.exitCode = 1; });
