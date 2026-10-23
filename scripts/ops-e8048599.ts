/** Owner-authorised ops for job e8048599 (2026-10-23). MODE=read is read-only. MODE=budget opens the immutable
 * recovery budget (cap from CAP_USD) — the ONLY write, and only with CONFIRM=OPEN-BUDGET-e8048599. */
import { createClient } from "@supabase/supabase-js";
import { connectResolved } from "./lib/supabase-db";
import { documentaryLedgerScopeFor } from "../src/lib/video/long-form/script-jobs";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
async function main() {
  const mode = process.env.MODE ?? "read";
  if (mode === "recraft-read") return recraftRead();
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
async function recraftRead() {
  const { client } = await connectResolved();
  try {
    const q = async (sql: string, a: unknown[] = []) => (await client.query(sql, a)).rows;
    log("POLICY", await q("select provider, enabled, unit, baseline, unit_cost_usd, daily_forecast, daily_cap_usd, monthly_cap_usd, max_concurrent, max_daily_calls, length(evidence) evidence_len, updated_at from public.pi_supply_policies where provider in ('recraft','__global__')"));
    log("SNAP", await q("select provider, unit, available, health, reliability, checked_at from public.pi_capacity_snapshots where provider = 'recraft' order by checked_at desc limit 3"));
    log("RECRAFT_ACCOUNT", await q("select provider, status, plan, balance_source, secret_reference_name from public.pi_provider_accounts where provider = 'recraft'"));
    log("RECRAFT_STATE", (await q("select public.pi_supply_state('recraft') s"))[0].s);
    log("RECRAFT_OPS", await q("select status, count(*) n, coalesce(sum(committed_usd),0) usd from public.pi_paid_operations where provider = 'recraft' group by 1"));
    const cols = await q("select column_name from information_schema.columns where table_name='pi_capacity_snapshots' and table_schema='public' order by ordinal_position");
    log("SNAP_COLUMNS", cols.map((c: any) => c.column_name));
  } finally { await client.end(); }
  const key = process.env.FAL_ADMIN_KEY?.trim();
  if (!key) return log("FAL", { adminKeyInGithubSecrets: false });
  const r = await fetch("https://api.fal.ai/v1/account/billing?expand=credits", { headers: { Authorization: `Key ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  const v = await r.json().catch(() => ({})) as any;
  log("FAL", { adminKeyInGithubSecrets: true, status: r.status, currency: v?.credits?.currency ?? null, balance: typeof v?.credits?.current_balance === "number" ? v.credits.current_balance : null });
}

main().catch(e => { console.error("FAILED", String(e).slice(0, 300)); process.exitCode = 1; });
