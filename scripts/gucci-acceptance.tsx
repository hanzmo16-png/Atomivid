/** Acceptance #10 on the existing Gucci job only (7b7d4b60). No new job.
 * PHASE=queue:  offline simulation first — saved responses + synthetic visual
 *               plans — must show that the ONLY new requests are the 5 per-beat
 *               visual plans and that the pipeline then finishes. Only then the
 *               same server function as the "Reintentar" button requeues the job
 *               (compare-and-swap). Dispatch happens separately.
 * PHASE=verify: reads job, approved script and ledger rows created after the
 *               requeue, and renders the deployed components (structural only). */
import { createClient } from "@supabase/supabase-js";
import { renderToStaticMarkup } from "react-dom/server";
import { stableHash } from "../src/lib/production-intelligence/canonical";
import { documentarySupplyScope } from "../src/lib/supply/anthropic";
import { researchDocumentary, RESEARCH_VERSION } from "../src/lib/video/long-form/research";
import { generateDocumentaryScript } from "../src/lib/video/long-form/documentary-script";
import { parseSources, parseOpenQuestions } from "../src/app/dashboard/long-form/new/parse";
import { EDITORIAL_VERSION, editorialApprovalError } from "../src/lib/video/long-form/editorial";
import { retryScriptJob } from "../src/lib/video/long-form/script-jobs";
import { SCRIPT_JOB_COLUMNS, scriptJobView, type ScriptJobSummary } from "../src/lib/video/long-form/script-job-types";
import { ScriptJobCard } from "../src/components/video/ScriptJobCard";

const PREFIX = "7b7d4b60";
async function main() {
  if (process.env.ANTHROPIC_API_KEY || process.env.VERCEL_ENV) throw Error("Offline environment required");
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: rows, error } = await db.from("documentary_script_jobs").select(`${SCRIPT_JOB_COLUMNS},user_id,input,run_token`);
  if (error) throw Error("read");
  const job = rows!.find(r => r.id.startsWith(PREFIX));
  if (!job) throw Error("Gucci job missing");
  const fields = job.input.fields;
  const scope = documentarySupplyScope(job.user_id, { ...fields, editorialVersion: EDITORIAL_VERSION, researchVersion: RESEARCH_VERSION, creativeHistory: job.input.creativeHistory }, false);

  if (process.env.PHASE === "queue") {
    if (job.status !== "failed" || job.run_token) throw Error(`Unexpected state ${job.status}`);
    const ops = await db.from("pi_paid_operations").select("shot_id,result_ref").eq("project_id", scope.projectId).eq("status", "COMMITTED");
    if (ops.error) throw Error("read");
    const saved = new Map<string, unknown>();
    for (const op of ops.data ?? []) {
      const f = await db.storage.from("videos").download(op.result_ref);
      if (f.error || !f.data) throw Error("read");
      saved.set(String(op.shot_id).split(":")[2], JSON.parse(await f.data.text()));
    }
    const newRequests: string[] = [];
    let hits = 0, approved = false;
    const originalFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = "offline-simulation-no-provider-key";
    globalThis.fetch = (async (_u: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body));
      const hit = saved.get(stableHash(body, 16));
      if (hit) { hits++; return new Response(JSON.stringify(hit), { status: 200, headers: { "content-type": "application/json" } }); }
      const system = String(body.system ?? "");
      newRequests.push(system.startsWith("Planifica escenas") ? "visual_plan" : "OTHER");
      if (!system.startsWith("Planifica escenas")) throw Error("NON_VISUAL_REQUEST");
      // Synthetic plan anchored to this beat's narration (simulation only).
      const words = (JSON.parse(body.messages[0].content).narration as string).split(/\s+/);
      const plan = { visuals: [0, 1].map(i => ({ description: "archival detail", motion: false, subject: "archive", quote: words.slice(i * 6, i * 6 + 6).join(" ") })) };
      return new Response(JSON.stringify({ id: "sim", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(plan) }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const researchPack = await researchDocumentary({ topic: fields.topic, references: parseSources(fields.sources), openQuestions: parseOpenQuestions(fields.openQuestions) });
      await generateDocumentaryScript({ researchPack, creativeHistory: job.input.creativeHistory, mode: "curiosity_documentary", language: fields.language,
        targetDurationSeconds: Number(fields.durationMinutes) * 60, onEditorialApproved: () => { approved = true; } });
    } finally { globalThis.fetch = originalFetch; delete process.env.ANTHROPIC_API_KEY; }
    console.log("SIMULATION", JSON.stringify({ hits, newRequests, approved }));
    if (hits !== 6 || newRequests.length !== 5 || newRequests.some(r => r !== "visual_plan") || !approved) throw Error("STOP: flow would make unauthorized calls");
    const since = new Date().toISOString();
    const result = await retryScriptJob(job.user_id, job.id, db);
    const again = await retryScriptJob(job.user_id, job.id, db); // double click
    console.log("REQUEUE", JSON.stringify({ first: result, secondClick: again, since }));
    if (result !== "queued" || again !== "refused") throw Error("requeue failed");
    return;
  }

  // verify
  const since = process.env.SINCE!;
  const ops = await db.from("pi_paid_operations").select("model,method,status,committed_usd,reserved_usd,created_at").eq("project_id", scope.projectId).gte("created_at", since).order("created_at");
  if (ops.error) throw Error("read");
  const all = await db.from("pi_paid_operations").select("project_id").eq("provider", "anthropic").gte("created_at", since);
  const { data: request } = await db.from("video_requests").select("status,script_json,long_form_confirmed_at").eq("id", job.request_id).maybeSingle();
  const script = request?.script_json as { beats: { visuals?: { quote: string }[]; narration: string }[]; editorial?: unknown } | undefined;
  console.log("JOB", JSON.stringify({ status: job.status, stage: job.stage, failureKind: job.failure_kind, retries: job.retry_count, running: !!job.run_token }));
  console.log("LEDGER", JSON.stringify({ newOpsThisProject: ops.data?.length, newAnthropicOpsAllProjects: all.data?.length,
    ops: ops.data?.map(o => ({ model: o.model, method: o.method, status: o.status, usd: o.committed_usd })),
    totalUsd: Number((ops.data ?? []).reduce((s, o) => s + Number(o.committed_usd ?? 0), 0).toFixed(4)) }));
  console.log("SCRIPT", JSON.stringify({ requestStatus: request?.status ?? null, productionConfirmed: !!request?.long_form_confirmed_at, beats: script?.beats.length,
    visualsPerBeat: script?.beats.map(b => b.visuals?.length ?? 0), visualsAnchored: script?.beats.every(b => (b.visuals ?? []).every(v => b.narration.includes(v.quote))),
    approvalCheck: script ? editorialApprovalError(script as never) ?? "valid" : null }));
  const view = scriptJobView(job as ScriptJobSummary, Date.now());
  const card = renderToStaticMarkup(ScriptJobCard({ job: job as ScriptJobSummary, nowMs: Date.now() }));
  console.log("UI", JSON.stringify({ label: view.label, action: view.action, refresh: view.refresh,
    configureLink: card.includes(`/dashboard/long-form/configure/${job.request_id}`), retryForm: card.includes('name="job_id"'), productionButton: card.includes("Iniciar producción") }));
}
main().catch(e => { console.error(e instanceof Error ? e.message : "failed"); process.exitCode = 1; });
