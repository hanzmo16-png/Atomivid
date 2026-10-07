/** Zero-provider recovery of saved documentary jobs in production.
 * - Gucci (7b7d4b60): replays its saved responses against the deployed pipeline
 *   code with networking replaced by exact-fingerprint lookups. It stops at the
 *   first request that has no saved response (a new paid call, never made) and
 *   stores the latest editorially reviewed draft as the job's private,
 *   UNAPPROVED checkpoint. It does not requeue, approve or create a video request.
 * - fc1c0e4d: pre-durable attempt without saved input; marked as a technical
 *   failure with no retry offered (a retry could not run).
 * Writes are fenced on id, owner, failed status, null run token and the exact
 * updated_at read before the replay. Only structural facts are printed. */
import { createClient } from "@supabase/supabase-js";
import { renderToStaticMarkup } from "react-dom/server";
import { stableHash } from "../src/lib/production-intelligence/canonical";
import { documentarySupplyScope } from "../src/lib/supply/anthropic";
import { researchDocumentary, RESEARCH_VERSION } from "../src/lib/video/long-form/research";
import { generateDocumentaryScript, type DocumentaryDraft } from "../src/lib/video/long-form/documentary-script";
import { parseSources, parseOpenQuestions } from "../src/app/dashboard/long-form/new/parse";
import { EDITORIAL_VERSION, editorialBlockers, ResolvedEditorialReviewSchema } from "../src/lib/video/long-form/editorial";
import { SCRIPT_JOB_COLUMNS, scriptJobView, type ScriptJobSummary } from "../src/lib/video/long-form/script-job-types";
import { ScriptJobCard } from "../src/components/video/ScriptJobCard";
import { DocumentaryDraftView } from "../src/components/video/DocumentaryDraftView";

const GUCCI = "7b7d4b60", TRUNCATED = "fc1c0e4d";
const RECOVERED_STAGE = "Revisión editorial aprobada · falta planificar imágenes";

async function main() {
  if (process.env.ANTHROPIC_API_KEY || process.env.SUPPLY_GUARD_ENFORCED === "true" || process.env.VERCEL_ENV) throw Error("Offline environment required");
  const write = process.env.RECOVER_WRITE === "true";
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: jobs, error } = await db.from("documentary_script_jobs").select(`${SCRIPT_JOB_COLUMNS},user_id,input,run_token,editorial_checkpoint`).eq("status", "failed");
  if (error) throw Error("read");
  const gucci = jobs!.find(j => j.id.startsWith(GUCCI)), truncated = jobs!.find(j => j.id.startsWith(TRUNCATED));

  if (gucci && gucci.stage !== RECOVERED_STAGE) {
    const fields = gucci.input.fields;
    const scope = documentarySupplyScope(gucci.user_id, { ...fields, editorialVersion: EDITORIAL_VERSION, researchVersion: RESEARCH_VERSION, creativeHistory: gucci.input.creativeHistory }, false);
    const ops = await db.from("pi_paid_operations").select("shot_id,result_ref").eq("project_id", scope.projectId).eq("status", "COMMITTED");
    if (ops.error) throw Error("read");
    const saved = new Map<string, unknown>();
    for (const op of ops.data ?? []) {
      const f = await db.storage.from("videos").download(op.result_ref);
      if (f.error || !f.data) throw Error("read");
      saved.set(String(op.shot_id).split(":")[2], JSON.parse(await f.data.text()));
    }
    let hits = 0, boundary = "", stage = "";
    let draft: DocumentaryDraft | undefined;
    const originalFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = "offline-replay-no-provider-key";
    globalThis.fetch = (async (_u: unknown, init?: { body?: unknown }) => {
      const response = saved.get(stableHash(JSON.parse(String(init?.body)), 16));
      if (!response) { boundary = stage; throw Error("OFFLINE_CACHE_BOUNDARY"); }
      hits++;
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const researchPack = await researchDocumentary({ topic: fields.topic, references: parseSources(fields.sources), openQuestions: parseOpenQuestions(fields.openQuestions) });
      await generateDocumentaryScript({ researchPack, creativeHistory: gucci.input.creativeHistory, mode: "curiosity_documentary", language: fields.language,
        targetDurationSeconds: Number(fields.durationMinutes) * 60, onStage: async l => { stage = l; }, onDraft: async d => { draft = d; } });
      throw Error("unexpected completion without provider");
    } catch (e) { if (!boundary) throw e; }
    finally { globalThis.fetch = originalFetch; delete process.env.ANTHROPIC_API_KEY; }
    const review = draft?.review ? ResolvedEditorialReviewSchema.parse(draft.review) : null;
    const blockers = review ? editorialBlockers(review).length : -1;
    console.log("GUCCI_REPLAY", JSON.stringify({ hits, boundary, draftPass: draft?.pass, reviewed: !!review, blockers, beats: draft?.script.beats.length }));
    if (!boundary.startsWith("Planificando imágenes") || !draft || blockers !== 0) throw Error("Recovery boundary not established");
    if (write) {
      const { data, error: e } = await db.from("documentary_script_jobs").update({ editorial_checkpoint: draft, failure_kind: "technical", error_code: null, stage: RECOVERED_STAGE,
        error_message: "Guion recuperado sin coste: la revisión editorial lo aprueba tras corregir el clasificador. Falta planificar las imágenes de 5 bloques (llamadas nuevas). Reintentar reutiliza las 6 respuestas guardadas.",
        updated_at: new Date().toISOString() })
        .eq("id", gucci.id).eq("user_id", gucci.user_id).eq("status", "failed").is("run_token", null).eq("updated_at", gucci.updated_at).select("id");
      if (e || data?.length !== 1) throw Error("Gucci recovery lost its lease");
      console.log("GUCCI_WRITE", JSON.stringify({ written: true, status: "failed", providerCalls: 0 }));
    }
  }
  if (truncated && write && truncated.retry_count !== 3) {
    // No saved input: a retry cannot run. Keep it as visible historical evidence.
    const { data, error: e } = await db.from("documentary_script_jobs").update({ failure_kind: "technical", retry_count: 3, updated_at: new Date().toISOString() })
      .eq("id", truncated.id).eq("status", "failed").is("run_token", null).eq("updated_at", truncated.updated_at).select("id");
    if (e || data?.length !== 1) throw Error("Truncated job update lost its lease");
    console.log("TRUNCATED_WRITE", JSON.stringify({ written: true, providerCalls: 0 }));
  }

  // Render the deployed components with the stored rows (structural checks only).
  const { data: after, error: readError } = await db.from("documentary_script_jobs").select(`${SCRIPT_JOB_COLUMNS},editorial_checkpoint`).in("status", ["failed", "queued", "running"]);
  if (readError) throw Error("read");
  for (const row of after ?? []) {
    const job = row as ScriptJobSummary & { editorial_checkpoint: unknown }, view = scriptJobView(job, Date.now());
    const card = renderToStaticMarkup(ScriptJobCard({ job, nowMs: Date.now() }));
    const draft = renderToStaticMarkup(DocumentaryDraftView({ value: job.editorial_checkpoint }) ?? <></>);
    console.log("UI", JSON.stringify({ job: job.id.slice(0, 8), status: job.status, failureKind: job.failure_kind, label: view.label, action: view.action,
      cardShowsLabel: card.includes(view.label), cardHasRetryForm: card.includes('name="job_id"') && !!view.action, noProductionButton: !card.includes("Iniciar producción"),
      draftShown: draft.includes("Borrador guardado"), draftBlocks: (draft.match(/Bloque \d+/g) ?? []).length, reviewerObjections: (draft.match(/<li>/g) ?? []).length }));
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : "recovery failed"); process.exitCode = 1; });
