/** Offline replay of job 290de42b against the CODE OF THE CHECKED-OUT BRANCH, as if the owner pressed «Pedir otra
 * corrección» (editorial_rounds 1 → 2). No provider key: the SDK transport only returns responses already COMMITTED
 * (paid) in this job's ledger, matched by the exact request fingerprint production uses (stableHash(params,16)).
 * The first request without a saved response is a boundary: reported, never sent. No writes of any kind. */
import { createClient } from "@supabase/supabase-js";
import { stableHash } from "../src/lib/production-intelligence/canonical";
import { researchDocumentary } from "../src/lib/video/long-form/research";
import { generateDocumentaryScript } from "../src/lib/video/long-form/documentary-script";
import { parseSources, parseOpenQuestions } from "../src/app/dashboard/long-form/new/parse";
import { editorialBlockers, EditorialQualityError, type EditorialReview } from "../src/lib/video/long-form/editorial";
import { documentarySupplyScope } from "../src/lib/supply/anthropic";
import { documentaryScopeInput } from "../src/lib/video/long-form/script-jobs";
import { ScriptJobFieldsSchema } from "../src/lib/video/long-form/script-job-types";
import { cinematicV6Enabled } from "../src/lib/video/long-form/cinematic-v6-access";
const JOB_ID = "290de42b-4aa6-4dba-855f-5c093a8d31ba";
async function main() {
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "VEO_API_KEY", "FAL_KEY"]) if (process.env[k]) throw Error("Provider key present: offline replay refused");
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: job, error } = await db.from("documentary_script_jobs").select("id,user_id,topic,status,input,editorial_rounds").eq("id", JOB_ID).single();
  if (error || !job?.input?.fields) throw Error("job unavailable");
  const fields = ScriptJobFieldsSchema.parse(job.input.fields);
  const scope = documentarySupplyScope(job.user_id, documentaryScopeInput(job.input, fields), false);
  const ops = await db.from("pi_paid_operations").select("shot_id,result_ref,status").eq("project_id", scope.projectId);
  const saved = new Map<string, unknown>();
  for (const op of ops.data ?? []) {
    if (op.status !== "COMMITTED" || typeof op.result_ref !== "string" || op.result_ref.startsWith("rejected:")) continue;
    const f = await db.storage.from("videos").download(op.result_ref); if (!f.data) throw Error("saved response unavailable");
    saved.set(String(op.shot_id).split(":")[2], JSON.parse(await f.data.text()));
  }
  const { data: owner } = await db.auth.admin.getUserById(job.user_id);
  const kindOf = (p: any) => { const s = typeof p.system === "string" ? p.system : JSON.stringify(p.system ?? "");
    return /Planifica escenas/.test(s) ? "visual-plan" : /editor crítico/.test(s) ? "review" : /guionista documental/.test(s) ? "writer" : "other"; };
  for (const rounds of [Number(job.editorial_rounds ?? 0), Number(job.editorial_rounds ?? 0) + 1]) {
    const calls: { kind: string; cached: boolean }[] = []; let boundary: string | null = null; const drafts: unknown[] = [];
    process.env.ANTHROPIC_API_KEY = "offline-replay-no-provider-key";
    globalThis.fetch = (async (_u: unknown, init?: { body?: unknown }) => {
      const params = JSON.parse(String(init?.body)), key = stableHash(params, 16), kind = kindOf(params), hit = saved.get(key);
      calls.push({ kind, cached: !!hit });
      if (!hit) { boundary = kind; throw Error("OFFLINE_CACHE_BOUNDARY"); }
      return new Response(JSON.stringify(hit), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    let outcome: Record<string, unknown>;
    try {
      const researchPack = await researchDocumentary({ topic: fields.topic, references: parseSources(fields.sources), openQuestions: parseOpenQuestions(fields.openQuestions) });
      await generateDocumentaryScript({ researchPack, creativeHistory: job.input.creativeHistory, referenceContract: job.input.referenceContract, writerContract: job.input.writerContract,
        editorialFeedback: job.input.editorialFeedback, extraEditorialRounds: rounds, mode: "curiosity_documentary", language: fields.language,
        targetDurationSeconds: Number(fields.durationMinutes) * 60, cinematicV6: cinematicV6Enabled(owner?.user),
        onDraft: async d => { const r = d.review as EditorialReview | null; drafts.push({ pass: d.pass, reviewed: !!r, reviewerBlockers: r ? editorialBlockers(r).length : null, issues: (d as any).issues ?? null }); } });
      outcome = { result: "approved_offline" };
    } catch (e) {
      outcome = boundary ? { result: "stopped_at_uncached_call", call: boundary } : { result: "stopped", error: e instanceof Error ? e.name : String(e),
        reasons: e instanceof EditorialQualityError ? e.reasons : undefined, detail: e instanceof Error ? e.message.slice(0, 200) : undefined };
    }
    console.log("REPLAY", JSON.stringify({ rounds, savedResponses: saved.size, calls, ...outcome }));
    for (const d of drafts) console.log("DRAFT", JSON.stringify(d));
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : "replay failed"); process.exitCode = 1; });
