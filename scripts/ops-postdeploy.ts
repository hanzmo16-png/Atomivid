/** Post-deploy verification (read-only). No generation, no writes. Prints structure only. */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { providerConfigSignature } from "../src/lib/ops/provider-config";
import { scriptJobSignature, SCRIPT_JOB_PATH } from "../src/lib/video/long-form/script-job-auth";
import { documentaryLedgerScopeFor } from "../src/lib/video/long-form/script-jobs";

const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
const DEPLOYED_AT = process.env.DEPLOYED_AT ?? "2026-10-23T21:39:22Z";
async function probe(origin: string) {
  const out: Record<string, unknown> = { origin };
  try {
    const nonce = randomUUID(), ts = String(Date.now());
    const r = await fetch(`${origin}/api/internal/provider-config`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(60_000),
      headers: { "x-probe-nonce": nonce, "x-probe-time": ts, "x-probe-signature": providerConfigSignature(key, nonce, ts) } });
    out.configStatus = r.status;
    if (r.ok) { const j = await r.json() as Record<string, any>; out.commit = j.commit; out.vercelEnv = j.vercelEnv;
      out.keys = Object.fromEntries(Object.entries(j.keys ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : typeof v])); out.avatar = j.avatar ? Object.keys(j.avatar).slice(0, 8) : null; }
    else out.location = r.headers.get("location")?.replace(/\?.*/, "");
  } catch (e) { out.error = String(e).slice(0, 120); }
  for (const p of ["/", "/login", "/dashboard", "/dashboard/long-form/new", "/dashboard/new", "/dashboard/podcast"]) {
    try { const x = await fetch(`${origin}${p}`, { redirect: "manual", signal: AbortSignal.timeout(30_000) }); (out.pages ??= {} as any)[p] = `${x.status}${x.headers.get("location") ? "→" + new URL(x.headers.get("location")!, origin).pathname : ""}`; }
    catch (e) { (out.pages ??= {} as any)[p] = String(e).slice(0, 60); }
  }
  try { const x = await fetch(`${origin}/api/production-check`, { method: "POST", body: "{}", signal: AbortSignal.timeout(30_000) }); out.productionCheckUnauth = x.status; } catch { out.productionCheckUnauth = "error"; }
  try {
    const id = randomUUID(), ts = String(Date.now());
    const r = await fetch(`${origin}${SCRIPT_JOB_PATH}`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(60_000),
      headers: { "x-script-job": id, "x-script-time": ts, "x-script-signature": scriptJobSignature(key, id, ts), "x-script-probe": "1" } });
    out.scriptWorker = `${r.status} ${(await r.text()).slice(0, 40)}`;
  } catch (e) { out.scriptWorker = String(e).slice(0, 80); }
  log("PROBE", out);
}
async function data() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs, error: je } = await db.from("documentary_script_jobs").select("*").order("created_at", { ascending: false }).limit(50);
  if (je) log("JOB_READ_ERROR", { code: je.code, message: je.message.slice(0, 80) });
  const j = (jobs ?? []).find((x: any) => String(x.id).startsWith("e8048599")) as Record<string, any>;
  if (j) {
    const scope = documentaryLedgerScopeFor(j as never);
    const { data: ops } = await db.from("pi_paid_operations").select("status,committed_usd,created_at").eq("project_id", scope);
    log("JOB_E8048599", { status: j.status, stage: j.stage, kind: j.failure_kind, code: j.error_code, retries: j.retry_count, rounds: j.editorial_rounds, resubmits: j.resubmit_allowance,
      runToken: !!j.run_token, updated: j.updated_at, checkpoint: { pass: j.editorial_checkpoint?.pass, beats: j.editorial_checkpoint?.script?.beats?.length, review: !!j.editorial_checkpoint?.review },
      ledger: { ops: ops?.length, committed: ops?.filter((o: any) => o.status === "COMMITTED").length, usd: Number((ops ?? []).reduce((a: number, o: any) => a + Number(o.committed_usd ?? 0), 0).toFixed(4)),
        last: ops?.map((o: any) => o.created_at).sort().at(-1) },
      retryAvailable: j.status === "failed" && (j.failure_kind === "editorial" ? j.editorial_rounds < 2 : j.retry_count < 3) });
  }
  const { data: after } = await db.from("pi_paid_operations").select("provider,status,method").gte("created_at", DEPLOYED_AT);
  const agg: Record<string, number> = {}; for (const o of (after ?? []) as any[]) agg[`${o.provider}:${o.method}:${o.status}`] = (agg[`${o.provider}:${o.method}:${o.status}`] ?? 0) + 1;
  log("PAID_OPS_SINCE_DEPLOY", agg);
  const { data: stuck } = await db.from("documentary_script_jobs").select("id,status,updated_at").eq("status", "running");
  log("RUNNING_SCRIPT_JOBS", (stuck ?? []).map((s: any) => ({ id: String(s.id).slice(0, 8), updated: s.updated_at })));
  for (const mode of ["visual", "avatar", "long_form"]) {
    const { data: r, error: me } = await db.from("video_requests").select("*").eq("mode", mode).order("created_at", { ascending: false }).limit(4);
    log("MODE", { mode, error: me?.message?.slice(0, 60), last: (r ?? []).map((x: any) => `${x.status}@${String(x.updated_at ?? x.created_at).slice(0, 16)}`) });
  }
  const { data: pe } = await db.from("podcast_episodes").select("status,video_status,updated_at").order("updated_at", { ascending: false }).limit(5);
  log("PODCAST", (pe ?? []).map((x: any) => `${x.status}/${x.video_status}@${String(x.updated_at).slice(0, 16)}`));
}
(async () => { if (process.env.ONLY_DATA !== "1") for (const o of ["https://atomicvid.app", "https://atomivid.vercel.app"]) await probe(o); await data(); })().catch(e => { console.error("FAILED", String(e).slice(0, 200)); process.exitCode = 1; });
