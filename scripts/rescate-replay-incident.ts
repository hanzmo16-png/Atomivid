/**
 * Rescate (2026-10-23) — replay OFFLINE y de SOLO LECTURA de un job de guion fallido a través del código
 * actual (capa B de normalización), reutilizando EXCLUSIVAMENTE respuestas COMMITTED del ledger.
 *
 * Garantías:
 *  - Nunca llama a un proveedor: fetch se sustituye por búsquedas por huella exacta (stableHash(params,16));
 *    una huella sin respuesta guardada es un LÍMITE (sería una llamada pagada nueva) y se reporta, nunca se hace.
 *  - No escribe filas ni archivos remotos: solo SELECT en documentary_script_jobs / pi_paid_operations y
 *    descarga de Storage. Idempotente: ejecutarlo N veces produce el mismo informe.
 *  - Puertas: exige RESCATE_CONFIRM_READ_ONLY=1 y --job=<uuid o prefijo>; se niega si hay clave de proveedor,
 *    SUPPLY_GUARD_ENFORCED=true o VERCEL_ENV (no corre dentro de producción).
 *  - Solo imprime hechos estructurales (etapas, aciertos de caché, clase de resultado), nunca texto del guion.
 *
 * La recuperación REAL en producción no necesita este script: con la corrección desplegada, el botón
 * «Reintentar» (retryScriptJob, CAS sobre updated_at, retry_count 2 < 3) re-ejecuta el job y reutiliza gratis
 * las respuestas ya pagadas. Este script sirve para comprobarlo ANTES, sin tocar nada.
 *
 * Uso: RESCATE_CONFIRM_READ_ONLY=1 SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/rescate-replay-incident.ts --job=e8048599
 */
import { createClient } from "@supabase/supabase-js";
import { stableHash } from "../src/lib/production-intelligence/canonical";
import { documentarySupplyScope } from "../src/lib/supply/anthropic";
import { researchDocumentary, RESEARCH_VERSION } from "../src/lib/video/long-form/research";
import { generateDocumentaryScript } from "../src/lib/video/long-form/documentary-script";
import { parseSources, parseOpenQuestions } from "../src/app/dashboard/long-form/new/parse";
import { EDITORIAL_VERSION, editorialBlockers, EditorialQualityError } from "../src/lib/video/long-form/editorial";
import { scriptFailureKind } from "../src/lib/video/long-form/script-jobs";

async function main() {
  const jobArg = process.argv.find(a => a.startsWith("--job="))?.slice(6) ?? "";
  if (process.env.RESCATE_CONFIRM_READ_ONLY !== "1") throw Error("Falta RESCATE_CONFIRM_READ_ONLY=1");
  if (!/^[0-9a-f-]{8,36}$/.test(jobArg)) throw Error("Indica --job=<uuid o prefijo de 8>");
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.SUPPLY_GUARD_ENFORCED === "true" || process.env.VERCEL_ENV)
    throw Error("Entorno offline requerido (sin claves de proveedor ni producción)");
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: rows, error } = await db.from("documentary_script_jobs").select("id,user_id,input,status,editorial_rounds,retry_count").eq("status", "failed");
  if (error) throw Error("read jobs");
  const job = (rows ?? []).find(r => String(r.id).startsWith(jobArg));
  if (!job?.input?.fields) throw Error("Job no encontrado, no fallido o sin entrada durable");
  const fields = job.input.fields;
  const scope = documentarySupplyScope(job.user_id, { ...fields, editorialVersion: EDITORIAL_VERSION, researchVersion: RESEARCH_VERSION, creativeHistory: job.input.creativeHistory,
    ...(job.input.referenceContract ? { referenceContract: job.input.referenceContract } : {}) }, false);
  const ops = await db.from("pi_paid_operations").select("shot_id,result_ref,committed_usd").eq("project_id", scope.projectId).eq("status", "COMMITTED");
  if (ops.error) throw Error("read ledger");
  const responses = new Map<string, unknown>(); let paidUsd = 0;
  for (const op of ops.data ?? []) {
    const f = await db.storage.from("videos").download(op.result_ref);
    if (f.error || !f.data) throw Error("read storage");
    responses.set(String(op.shot_id).split(":")[2], JSON.parse(await f.data.text())); paidUsd += Number(op.committed_usd ?? 0);
  }
  let hits = 0, boundary: string | null = null, stage = "Investigando fuentes", approved = false, blockers = -1;
  const stages: string[] = [], warnings: string[] = [];
  const originalWarn = console.warn; console.warn = (...a: unknown[]) => { warnings.push(String(a[0])); };
  const originalFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "offline-replay-no-provider-key";
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const saved = responses.get(stableHash(JSON.parse(String(init?.body)), 16));
    if (!saved) { boundary = stage; throw Error("OFFLINE_CACHE_BOUNDARY"); }
    hits++; return new Response(JSON.stringify(saved), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  let outcome: Record<string, unknown>;
  try {
    const researchPack = await researchDocumentary({ topic: fields.topic, references: parseSources(fields.sources), openQuestions: parseOpenQuestions(fields.openQuestions) });
    await generateDocumentaryScript({ researchPack, creativeHistory: job.input.creativeHistory, referenceContract: job.input.referenceContract, writerContract: job.input.writerContract,
      extraEditorialRounds: job.editorial_rounds ?? 0, allowVisualSceneRepair: (job.retry_count ?? 0) > 0,
      mode: "curiosity_documentary", language: fields.language, targetDurationSeconds: Number(fields.durationMinutes) * 60,
      onStage: async l => { stage = l; stages.push(l); }, onEditorialApproved: r => { approved = true; blockers = editorialBlockers(r.reviews.at(-1)!).length; } });
    outcome = { result: "approved_without_new_calls" };
  } catch (e) {
    outcome = boundary ? { result: "needs_new_provider_call", at: boundary }
      : { result: "stopped", kind: scriptFailureKind(e), error: e instanceof Error ? e.name : "unknown", reasons: e instanceof EditorialQualityError ? e.reasons.length : undefined };
  } finally { globalThis.fetch = originalFetch; delete process.env.ANTHROPIC_API_KEY; console.warn = originalWarn; }
  console.log("RESCATE_REPLAY", JSON.stringify({ job: String(job.id).slice(0, 8), savedResponses: responses.size, savedUsd: Number(paidUsd.toFixed(4)), hits, approved, blockers,
    normalizations: warnings.filter(w => w.includes("format-normalized")).length, unverifiedOpening: warnings.filter(w => w.includes("opening-payoff-unverified")).length, stages, ...outcome }));
}
main().catch(e => { console.error(e instanceof Error ? e.message : "replay failed"); process.exitCode = 1; });
