/** Offline replay of saved documentary jobs against the CURRENT pipeline code.
 * Provider networking is replaced by exact-fingerprint lookups of COMMITTED
 * ledger responses; a missing response is a boundary (it would be a new paid
 * call) and is reported, never made. Read-only: no row or file is written.
 * Only structural facts are printed (stages, hit counts, outcome class). */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { stableHash } from "../src/lib/production-intelligence/canonical";
import { documentarySupplyScope } from "../src/lib/supply/anthropic";
import { researchDocumentary, RESEARCH_VERSION } from "../src/lib/video/long-form/research";
import { generateDocumentaryScript } from "../src/lib/video/long-form/documentary-script";
import { parseSources, parseOpenQuestions } from "../src/app/dashboard/long-form/new/parse";
import { EDITORIAL_VERSION, editorialBlockers, EditorialQualityError } from "../src/lib/video/long-form/editorial";
import { scriptFailureKind } from "../src/lib/video/long-form/script-jobs";

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);
async function main() {
  if (process.env.ANTHROPIC_API_KEY || process.env.SUPPLY_GUARD_ENFORCED === "true" || process.env.VERCEL_ENV) throw Error("Offline environment required");
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const jobs = await db.from("documentary_script_jobs").select("id,user_id,input,status").eq("status", "failed");
  if (jobs.error) throw Error("read");
  const originalFetch = globalThis.fetch;
  for (const job of jobs.data ?? []) {
    if (!job.input?.fields) { console.log("REPLAY", JSON.stringify({ job: job.id.slice(0, 8), replayable: false, reason: "no saved input (pre-durable attempt)" })); continue; }
    const fields = job.input.fields;
    const scope = documentarySupplyScope(job.user_id, { ...fields, editorialVersion: EDITORIAL_VERSION, researchVersion: RESEARCH_VERSION, creativeHistory: job.input.creativeHistory,
      ...(job.input.referenceContract ? { referenceContract: job.input.referenceContract } : {}) }, false);
    const ops = await db.from("pi_paid_operations").select("shot_id,result_ref").eq("project_id", scope.projectId).eq("status", "COMMITTED");
    if (ops.error) throw Error("read");
    const responses = new Map<string, unknown>();
    for (const op of ops.data ?? []) {
      const f = await db.storage.from("videos").download(op.result_ref);
      if (f.error || !f.data) throw Error("read");
      responses.set(String(op.shot_id).split(":")[2], JSON.parse(await f.data.text()));
    }
    let hits = 0, boundary: string | null = null, stage = "Investigando fuentes", approved = false, blockersAtApproval = -1;
    const stages: string[] = [];
    process.env.ANTHROPIC_API_KEY = "offline-replay-no-provider-key";
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const params = JSON.parse(String(init?.body));
      const saved = responses.get(stableHash(params, 16));
      if (!saved) { boundary = stage; throw Error("OFFLINE_CACHE_BOUNDARY"); }
      hits++;
      return new Response(JSON.stringify(saved), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    let outcome: Record<string, unknown>;
    try {
      const researchPack = await researchDocumentary({ topic: fields.topic, references: parseSources(fields.sources), openQuestions: parseOpenQuestions(fields.openQuestions) });
      await generateDocumentaryScript({ researchPack, creativeHistory: job.input.creativeHistory, referenceContract: job.input.referenceContract, writerContract: job.input.writerContract,
        mode: "curiosity_documentary", language: fields.language, targetDurationSeconds: Number(fields.durationMinutes) * 60,
        onStage: async l => { stage = l; stages.push(l); },
        onEditorialApproved: r => { approved = true; blockersAtApproval = editorialBlockers(r.reviews.at(-1)!).length; } });
      outcome = { result: "approved" };
    } catch (error) {
      outcome = boundary ? { result: "needs_new_provider_call", at: boundary }
        : { result: "stopped", kind: scriptFailureKind(error), error: error instanceof Error ? error.name : "unknown",
          reasons: error instanceof EditorialQualityError ? error.reasons.length : undefined };
    } finally { globalThis.fetch = originalFetch; delete process.env.ANTHROPIC_API_KEY; }
    console.log("REPLAY", JSON.stringify({ job: job.id.slice(0, 8), project: h(scope.projectId), savedResponses: responses.size, hits, approved, blockersAtApproval, stages, ...outcome }));
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : "replay failed"); process.exitCode = 1; });
