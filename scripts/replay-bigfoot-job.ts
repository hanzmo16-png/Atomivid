/** Offline replay of ONE saved documentary job (Bigfoot, 03738404) against the CURRENT code.
 * - No provider key: the SDK transport is replaced by an adapter that ONLY returns responses
 *   already COMMITTED (paid) in the ledger for this job, matched by the exact request
 *   fingerprint (stableHash(params, 16)) that production uses as the ledger key.
 * - A request without a saved response is a boundary: the replay stops there and reports
 *   what is still uncached. It never calls the provider.
 * - Writes are disabled: this script never updates rows, files, the checkpoint or the ledger.
 * Only structure is printed (stages, hit counts, counts of findings), never script content. */
import { createClient } from "@supabase/supabase-js";
import { stableHash } from "../src/lib/production-intelligence/canonical";
import { researchDocumentary } from "../src/lib/video/long-form/research";
import { generateDocumentaryScript } from "../src/lib/video/long-form/documentary-script";
import { DocumentaryResponseError } from "../src/lib/video/long-form/json-response";
import { parseSources, parseOpenQuestions } from "../src/app/dashboard/long-form/new/parse";
import { EDITORIAL_VERSION, editorialBlockers, EditorialQualityError, type EditorialReview } from "../src/lib/video/long-form/editorial";
import { RESEARCH_VERSION } from "../src/lib/video/long-form/research";
import { documentarySupplyScope } from "../src/lib/supply/anthropic";
import { scriptFailureKind } from "../src/lib/video/long-form/script-jobs";
import { cinematicV6Enabled } from "../src/lib/video/long-form/cinematic-v6-access";
import { FUNCTION_REPAIR_CONTRACT } from "../src/lib/video/long-form/editorial-function-repair";
import { anthropicReservation } from "../src/lib/supply/anthropic-cost";
import { getPricingConfig } from "../src/lib/billing/pricing";

/** SIMULATED repair label (test adapter only; the real choice belongs to the model under the repair contract). */
const SIMULATED_REPAIR_LABEL = "consequence";

const JOB_ID = "03738404-02ce-440a-a588-cb51ae4a0e9f";

async function main() {
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "RUNWAY_API_KEY", "ELEVENLABS_API_KEY", "VEO_API_KEY", "GOOGLE_API_KEY"]) if (process.env[k]) throw Error("Provider key present: offline replay refused");
  if (process.env.SUPPLY_GUARD_ENFORCED === "true" || process.env.VERCEL_ENV) throw Error("Offline environment required");
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: job, error } = await db.from("documentary_script_jobs").select("id,user_id,topic,status,stage,input,editorial_rounds,editorial_checkpoint").eq("id", JOB_ID).single();
  if (error || !job?.input?.fields) throw Error("Target job unavailable");
  if (!/bigfoot|pie grande|sasquatch|big foot/i.test(job.topic)) throw Error("Target topic does not match Bigfoot");
  const checkpointBefore = stableHash(job.editorial_checkpoint ?? null, 16);
  const fields = job.input.fields;
  const scope = documentarySupplyScope(job.user_id, { ...fields, editorialVersion: EDITORIAL_VERSION, researchVersion: RESEARCH_VERSION, creativeHistory: job.input.creativeHistory,
    ...(job.input.referenceContract ? { referenceContract: job.input.referenceContract } : {}) }, false);
  const ops = await db.from("pi_paid_operations").select("shot_id,result_ref,status").eq("project_id", scope.projectId).eq("provider", "anthropic");
  if (ops.error) throw Error("Ledger read unavailable");
  const responses = new Map<string, unknown>();
  for (const op of ops.data ?? []) {
    if (op.status !== "COMMITTED" || typeof op.result_ref !== "string" || op.result_ref.startsWith("rejected:")) continue;
    if (!op.result_ref.startsWith(`${scope.projectId}/paid/`)) throw Error("Unexpected result scope");
    const f = await db.storage.from("videos").download(op.result_ref);
    if (f.error || !f.data) throw Error("Saved response unavailable");
    responses.set(String(op.shot_id).split(":")[2], JSON.parse(await f.data.text()));
  }
  const { data: owner } = await db.auth.admin.getUserById(job.user_id);
  const cinematicV6 = cinematicV6Enabled(owner?.user);

  const simulatedRepairs = new Map<string, unknown>();
  let simulatedRepairCalls = 0;
  const runOnce = async (label: string) => {
  let stage = "Investigando fuentes", boundary: { stage: string; call: string; maxTokens: number; reservationUsd: number } | null = null, approved = false;
  const used = new Set<string>(), stages: string[] = [], drafts: { pass: number; reviewed: boolean; blockers?: number; findings?: number }[] = [];
  let repairReused = 0;
  process.env.ANTHROPIC_API_KEY = "offline-replay-no-provider-key"; // the SDK requires a value; the transport below never reaches the network
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const params = JSON.parse(String(init?.body));
    const key = stableHash(params, 16);
    const sys = typeof params.system === "string" ? params.system : "";
    if (sys.includes(FUNCTION_REPAIR_CONTRACT)) {
      // SIMULATED adapter for the bounded repair (never a provider): one stored answer per exact request.
      if (!simulatedRepairs.has(key)) {
        simulatedRepairCalls++;
        const prompt = JSON.parse(params.messages[0].content) as { targets: { path: string }[] };
        simulatedRepairs.set(key, { id: "simulated", type: "message", role: "assistant", model: params.model, stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: "text", text: JSON.stringify({ replacements: prompt.targets.map((t) => ({ path: t.path, function: SIMULATED_REPAIR_LABEL })) }) }] });
        repairReservation = anthropicReservation(params, getPricingConfig());
      } else repairReused++;
      return new Response(JSON.stringify(simulatedRepairs.get(key)), { status: 200, headers: { "content-type": "application/json" } });
    }
    const saved = responses.get(key);
    if (!saved) {
      const call = /Planifica escenas/.test(sys) ? "visual-plan" : /excerptId del catálogo que respalda/.test(sys) ? "reference-repair" : /sections/.test(sys) && /firstAnswer/.test(sys) ? "editorial-review" : "writer-or-correction";
      boundary = { stage, call, maxTokens: params.max_tokens, reservationUsd: Math.round(anthropicReservation(params, getPricingConfig()) * 10000) / 10000 };
      throw Error("OFFLINE_CACHE_BOUNDARY");
    }
    used.add(key);
    return new Response(JSON.stringify(saved), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  let outcome: Record<string, unknown>;
  try {
    const researchPack = await researchDocumentary({ topic: fields.topic, references: parseSources(fields.sources), openQuestions: parseOpenQuestions(fields.openQuestions) });
    await generateDocumentaryScript({ researchPack, creativeHistory: job.input.creativeHistory, referenceContract: job.input.referenceContract, writerContract: job.input.writerContract,
      extraEditorialRounds: job.editorial_rounds ?? 0, mode: "curiosity_documentary", language: fields.language, targetDurationSeconds: Number(fields.durationMinutes) * 60, cinematicV6,
      onStage: async (l) => { stage = l; stages.push(l); },
      onDraft: async (d) => { const r = d.review as EditorialReview | null; drafts.push({ pass: d.pass, reviewed: !!r, ...(r ? { blockers: editorialBlockers(r).length, findings: r.findings.length } : {}) }); },
      onEditorialApproved: () => { approved = true; } });
    outcome = { result: "approved_offline" };
  } catch (err) {
    const hit = boundary as { stage: string; call: string } | null; // assigned inside the transport closure
    outcome = hit ? { result: "stopped_at_uncached_call", ...hit }
      : { result: "stopped", kind: scriptFailureKind(err), error: err instanceof Error ? err.name : "unknown", detail: err instanceof Error ? err.message.slice(0, 160) : undefined,
        reasons: err instanceof EditorialQualityError ? err.reasons.length : undefined, schemaIssues: err instanceof DocumentaryResponseError ? err.issues : undefined };
  } finally { globalThis.fetch = originalFetch; delete process.env.ANTHROPIC_API_KEY; }
  console.log("REPLAY", JSON.stringify({ run: label, savedResponses: responses.size, reused: used.size, unusedSaved: responses.size - used.size, simulatedRepairCalls, repairReused,
    simulatedRepairLabel: SIMULATED_REPAIR_LABEL, cinematicV6, stages, drafts, approved, ...outcome }));
  };
  let repairReservation = 0;
  await runOnce("first");
  await runOnce("resume");
  console.log("REPAIR", JSON.stringify({ contract: FUNCTION_REPAIR_CONTRACT, simulatedRepairCalls, reservationUsd: Math.round(repairReservation * 10000) / 10000 }));

  const { data: after } = await db.from("documentary_script_jobs").select("status,stage,editorial_checkpoint").eq("id", JOB_ID).single();
  console.log("INVARIANTS", JSON.stringify({ newPaidCalls: 0, productionWrites: 0, checkpointUnchanged: stableHash(after?.editorial_checkpoint ?? null, 16) === checkpointBefore, jobStatus: after?.status, jobStage: after?.stage }));
}
main().catch((e) => { console.error("Offline replay failed:", e instanceof Error ? e.message.slice(0, 160) : "unknown"); process.exitCode = 1; });
