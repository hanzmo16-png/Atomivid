/**
 * Owner-authorised, CAPPED resume of e8048599 (2026-10-23 16:38): USD 0.20 maximum of NEW spend.
 * Barrier: each HTTP invocation of the script step admits at most ONE new paid request (admitDocumentaryCall,
 * enforced in code before any reservation), and a request never costs more than its reservation. Before every
 * invocation: newSpend + PER_CALL_BOUND <= CAP, otherwise stop WITHOUT invoking. The existing immutable USD 0.60
 * recovery budget stays untouched as a second, database-enforced ceiling. Nothing is deleted or rewritten here.
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { documentaryLedgerScopeFor } from "../src/lib/video/long-form/script-jobs";
import { scriptJobSignature, SCRIPT_JOB_PATH } from "../src/lib/video/long-form/script-job-auth";
import { providerConfigSignature } from "../src/lib/ops/provider-config";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
const CAP = 0.20, PER_CALL_BOUND = 0.10, ORIGIN = "https://atomivid.vercel.app", EXPECTED_COMMIT = process.env.EXPECTED_COMMIT ?? "2cc9a22";
async function main() {
  if (process.env.CONFIRM !== "STEP-e8048599-0.20") throw Error("confirmation missing");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
  const db = createClient(process.env.SUPABASE_URL!.trim(), key, { auth: { persistSession: false, autoRefreshToken: false } });
  // 1) Production runs the merged code.
  { const nonce = randomUUID(), ts = String(Date.now());
    const r = await fetch(`${ORIGIN}/api/internal/provider-config`, { method: "POST", headers: { "x-probe-nonce": nonce, "x-probe-time": ts, "x-probe-signature": providerConfigSignature(key, nonce, ts) } });
    const j = await r.json() as any; log("PROD", { status: r.status, commit: j.commit, env: j.vercelEnv, keys: j.keys });
    if (j.commit !== EXPECTED_COMMIT) return log("STOP", { reason: "production does not run the expected commit" }); }
  // 2) No concurrent execution: no running GitHub worker, job queued without a run token.
  const gh = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/documentary-script.yml/runs?status=in_progress`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" } });
  const active = gh.ok ? ((await gh.json()) as any).total_count : -1;
  const queuedRuns = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/documentary-script.yml/runs?status=queued`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" } }).then(r => r.ok ? r.json() : { total_count: -1 }).then((x: any) => x.total_count);
  const { data: jobs } = await db.from("documentary_script_jobs").select("*").order("created_at", { ascending: false }).limit(50);
  let j = (jobs ?? []).find((x: any) => String(x.id).startsWith("e8048599")) as any;
  log("PRECHECK", { workerRunsInProgress: active, workerRunsQueued: queuedRuns, status: j.status, runToken: !!j.run_token, updated: j.updated_at });
  if (active !== 0 || queuedRuns !== 0 || j.status !== "queued" || j.run_token) return log("STOP", { reason: "possible concurrent execution or unexpected state" });
  const scope = documentaryLedgerScopeFor(j)!;
  const { data: budget } = await db.from("pi_recovery_budgets").select("baseline_keys,cap_usd,status").eq("project_id", scope).single();
  const baseline = new Set<string>((budget as any).baseline_keys);
  const newSpend = async () => {
    const { data } = await db.from("pi_paid_operations").select("idempotency_key,status,reserved_usd,committed_usd").eq("project_id", scope);
    const fresh = (data ?? []).filter((o: any) => !baseline.has(o.idempotency_key));
    const usd = fresh.reduce((a: number, o: any) => a + (o.status === "COMMITTED" ? Number(o.committed_usd ?? o.reserved_usd ?? 0)
      : ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"].includes(o.status) ? Number(o.reserved_usd ?? 0) : 0), 0);
    return { usd, ops: fresh.map((o: any) => `${o.status}:r${Number(o.reserved_usd ?? 0).toFixed(4)}:c${Number(o.committed_usd ?? 0).toFixed(4)}`) };
  };
  if (process.env.DRY === "1") { const s0 = await newSpend(); return log("DRY", { budget: { cap: (budget as any).cap_usd, status: (budget as any).status, baseline: baseline.size }, newSpendUsd: s0.usd, newOps: s0.ops }); }
  // 3) Capped step loop (one summary line at the end keeps the report readable).
  const steps: unknown[] = [];
  try { for (let step = 1; step <= 30; step++) {
    const before = await newSpend();
    if (before.usd + PER_CALL_BOUND > CAP + 1e-9) { log("STOP", { reason: "cap: next call could exceed USD 0.20", newSpendUsd: before.usd, ops: before.ops }); break; }
    const id = j.id, ts = String(Date.now());
    const r = await fetch(`${ORIGIN}${SCRIPT_JOB_PATH}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(320_000),
      headers: { "x-script-job": id, "x-script-time": ts, "x-script-signature": scriptJobSignature(key, id, ts) } });
    const body = await r.json().catch(() => ({})) as { state?: string };
    const after = await newSpend();
    const { data: row } = await db.from("documentary_script_jobs").select("status,stage,error_code,failure_kind").eq("id", id).single();
    steps.push(`${step}:${r.status}:${body.state}:${(row as any)?.stage}:+${(after.usd - before.usd).toFixed(4)}=${after.usd.toFixed(4)}`);
    if (!r.ok || body.state !== "queued") { log("END", { state: body.state, job: row, newSpendUsd: Number(after.usd.toFixed(4)), ops: after.ops }); break; }
  } } finally { log("STEPS", steps); }
}
main().catch(e => { console.error("FAILED", String(e).slice(0, 300)); process.exitCode = 1; });
