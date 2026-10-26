import { ScriptSchema } from "@/lib/ai/script";
import { scriptLengthReview } from "@/lib/video/script-length-review";
import { scriptBlockState } from "@/lib/supply/script-intent";
import { recoverPaidScript } from "@/lib/video/script-paid-recovery";
import { persistScriptChange, ScriptPersistenceError } from "@/lib/video/script-persistence";
import { ReelBudgetExceededError } from "@/lib/supply/reel-budget";
import { loadScriptOperations, withScriptGenerationContext } from "@/lib/supply/anthropic";
import { supplyGuardRequired } from "@/lib/supply/server";
import { runScriptGeneration } from "@/lib/video/script-generation";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { generateScriptForRequest, planOwnScriptForRequest } from "@/lib/video/generate-script";
import { draftFit, isOwnScriptDraft, narrationPreserved, scriptSourceOf, type OwnScriptDraft } from "@/lib/video/own-script";
import { checkHttpStatus, checkProductionForRequest, checkResponseBody } from "@/lib/supply/production-check";
import { recordScriptCall } from "@/lib/billing/usage";
import { classifyScriptError, logScriptError } from "@/lib/video/script-error";
import { generateDiagnosticId } from "@/lib/video/render-error";
import { checkScriptQuality, ScriptQualityError } from "@/lib/video/script-quality";
import { targetWordsFor } from "@/lib/video/script-pacing";
import type { GeneratedScript, ScriptLanguage } from "@/lib/providers/types";

// Sin esto, la función queda al límite por defecto de la plataforma (tan
// bajo como 10s en algunos planes de Vercel) — una llamada real a Claude
// para generar un guion completo, más los reintentos ante fallos
// transitorios (ver withRetry en providers/script/real.ts), puede
// superarlo. Cuando eso pasa, Vercel corta la función a medias: el cliente
// recibe un cuerpo vacío/truncado ("Unexpected end of JSON input" al
// intentar parsearlo) y la solicitud se queda sin marcar como fallida,
// visible en el historial como "Pendiente" para siempre. 60s da margen
// generoso para una llamada + reintentos sin ser excesivo.
export const maxDuration = 60;

type VideoRequestRow = {
  id: string;
  user_id: string;
  mode: string;
  recorded_audio_path: string | null;
  topic: string;
  style: string;
  duration_seconds: number;
  status: string;
  error_message: string | null;
  language: ScriptLanguage;
  render_attempts: number;
  script_json: GeneratedScript | OwnScriptDraft | null;
};

/** Thrown when a scene plan came back with a narration different from the customer's (never stored). */
class OwnNarrationChangedError extends Error {
  constructor() { super("OWN_NARRATION_CHANGED"); this.name = "OwnNarrationChangedError"; }
}

// Coincide con targetScenes en src/lib/ai/script.ts (máximo 10 para la
// duración más larga que ofrece la UI) con margen para ediciones manuales,
// sin dejarlo abierto a un guion arbitrariamente largo.
const MAX_SEGMENTS = 20;
const MAX_SCENE_TEXT_LENGTH = 800;
const MAX_VISUAL_QUERY_LENGTH = 200;

async function loadOwnedRequest(id: string, userId: string) {
  const service = createServiceClient();

  const { data: videoRequest, error } = await service
    .from("video_requests")
    .select("id, user_id, mode, topic, style, duration_seconds, status, language, recorded_audio_path, render_attempts, script_json, error_message")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle<VideoRequestRow>();

  if (error || !videoRequest) {
    return { service, videoRequest: null, response: NextResponse.json(
      { error: "Solicitud no encontrada" },
      { status: 404 },
    ) };
  }


  if (videoRequest.recorded_audio_path) return { service, videoRequest: null, response: NextResponse.json({ error: "Esta solicitud utiliza una grabación; no necesita guion generado." }, { status: 409 }) };
  return { service, videoRequest, response: null };
}

// Genera (o regenera, si falló) el guion completo y lo deja listo para
// revisión — todavía no gasta en voz/footage/música/render.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  // Red de seguridad: todo lo que sigue queda envuelto en un try/catch
  // único — cualquier fallo inesperado (no solo el del proveedor de
  // guion) debe devolver JSON válido, nunca un cuerpo vacío o una
  // excepción sin manejar que el cliente no pueda parsear.
  try {
    const { service, videoRequest, response } = await loadOwnedRequest(id, user.id);
    if (!videoRequest) return response!;

    // "script_ready" se permite además de "pending"/"failed" para poder
    // regenerar el guion completo (no solo escena por escena) cuando el
    // resultado ya guardado no es aceptable — p. ej. si vino de un
    // proveedor de respaldo o no pasó el control de calidad de abajo.
    // No se permite desde "processing"/"completed": eso sí requeriría una
    // solicitud nueva.
    if (
      videoRequest.status !== "pending" &&
      videoRequest.status !== "failed" &&
      videoRequest.status !== "script_ready"
    ) {
      return NextResponse.json(
        { error: `La solicitud ya está en estado "${videoRequest.status}"` },
        { status: 409 },
      );
    }

    // Recover only a settled, request-owned paid draft rejected solely for length.
    // This runs BEFORE any new provider admission and never falls back to another charge.
    if (videoRequest.status === "failed" && !videoRequest.script_json &&
        videoRequest.error_message?.startsWith("El guion no corresponde a la duración solicitada.")) {
      const rows = await loadScriptOperations(id);
      if (scriptBlockState(rows, Date.now())) return NextResponse.json({ error: "El intento anterior sigue en revisión. No se hizo otra llamada." }, { status: 409 });
      const { data: op, error } = await service.from("pi_paid_operations")
        .select("result_ref").eq("project_id", id).eq("provider", "anthropic").eq("method", "generate_script")
        .eq("status", "COMMITTED").order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error("PAID_SCRIPT_LOOKUP_FAILED");
      const script = await recoverPaidScript(id, op?.result_ref, async ref => {
        const { data, error: readError } = await service.storage.from("videos").download(ref);
        if (readError || !data) throw new Error("PAID_SCRIPT_READ_FAILED");
        return JSON.parse(await data.text());
      }, value => ScriptSchema.parse(value), videoRequest.topic);
      const note = scriptLengthReview(script, videoRequest.duration_seconds);
      const draft = { ...script, ...(note ? { lengthReviewRequired: true } : {}) };
      await persistScriptChange(service, videoRequest, { status: "script_ready", script_json: draft, error_message: note });
      return NextResponse.json({ status: "script_ready", script: draft });
    }

    // Control de costos (2026-10-18): plan, prices and Atomivid's provider capacity for the WHOLE
    // production are checked here, before the script — the first paid call. A foreseeable blocker stops
    // now, with who must act; nothing is reserved by this check (the script call is still admitted
    // atomically by pi_submit_with_supply, and the render reserves its envelope with the real script).
    // Guion propio: the customer's draft (or, to re-plan an own script already planned, its scenes as they
    // are now). The same draft is what the check sizes, what the call receives and what a failure keeps.
    const stored = videoRequest.script_json;
    const draft: OwnScriptDraft | null = isOwnScriptDraft(stored) ? stored
      : stored && scriptSourceOf(stored) === "own" && Array.isArray(stored.segments)
        ? { title: stored.title, segments: stored.segments.map(s => ({ text: s.text, visualQuery: "" })), source: "own", visualsPlanned: false, ownText: stored.segments.map(s => s.text).join(" ") }
        : null;
    const check = await checkProductionForRequest({ service, user, ownerId: user.id, stage: "before_script", requestId: id,
      fit: draft ? draftFit(draft, videoRequest.duration_seconds, videoRequest.language) : null,
      request: { mode: videoRequest.mode, duration_seconds: videoRequest.duration_seconds, language: videoRequest.language,
        topic: videoRequest.topic, style: videoRequest.style, recorded_audio_path: videoRequest.recorded_audio_path, script_json: draft } });
    if (check.outcome !== "ready") {
      return NextResponse.json(checkResponseBody(check), { status: checkHttpStatus(check) });
    }

    let lengthNote: string | null = null;
    const outcome = await runScriptGeneration({
      generate: async () => {
        if (draft?.source === "own") {
          const result = await withScriptGenerationContext(id, () => planOwnScriptForRequest({
            scenes: draft.segments.map(s => s.text), style: videoRequest.style, durationSeconds: videoRequest.duration_seconds, language: videoRequest.language,
          }));
          // By construction the model never returns the narration; this re-check refuses any provider that does.
          if (!narrationPreserved(draft, result.script)) throw new OwnNarrationChangedError();
          const quality = checkScriptQuality(result.script, { topic: videoRequest.topic, targetWords: 0, providerName: result.providerName, narrationIsOwn: true });
          if (!quality.ok) throw new ScriptQualityError(quality);
          return { ...result.script, source: "own" } as GeneratedScript;
        }
        const result = await withScriptGenerationContext(id, () => generateScriptForRequest({
          topic: videoRequest.topic,
          style: videoRequest.style,
          durationSeconds: videoRequest.duration_seconds,
          language: videoRequest.language,
          sourceText: draft?.source === "adapt" ? draft.ownText : undefined,
        }));

        const quality = checkScriptQuality(result.script, {
          topic: videoRequest.topic,
          targetWords: targetWordsFor(videoRequest.duration_seconds),
          providerName: result.providerName,
        });
        if (!quality.ok) {
          if (quality.issue !== "word_count_out_of_range") throw new ScriptQualityError(quality);
          lengthNote = scriptLengthReview(result.script, videoRequest.duration_seconds);
          result.script = { ...result.script, lengthReviewRequired: true };
        }
        return draft?.source === "adapt" ? { ...result.script, source: "adapt" } as GeneratedScript : result.script;
      },
      persist: (patch) => persistScriptChange(service, videoRequest, lengthNote && patch.status === "script_ready" ? { ...patch, error_message: lengthNote } : patch),
      guard: supplyGuardRequired(),
      loadRows: () => loadScriptOperations(id),
      // The customer's text is never lost: a failed planning or adaptation keeps what was stored (the draft,
      // or the own script already planned when its visuals were being re-planned).
      keepOnFailure: draft ? stored : undefined,
    });
    if (outcome.status !== 200) return NextResponse.json(outcome.body, { status: outcome.status, headers: "headers" in outcome ? outcome.headers : undefined });
    const script = outcome.body.script;

    const inputChars = videoRequest.topic.length + videoRequest.style.length;
    const outputChars = JSON.stringify(script).length;
    await recordScriptCall(service, id, { inputChars, outputChars }).catch((err) => {
      console.warn(`No se pudo registrar el costo de guion de ${id}:`, err);
    });

    return NextResponse.json(outcome.body);
  } catch (error) {
    const diagnosticId = generateDiagnosticId();
    logScriptError("POST /script (inesperado)", error, diagnosticId);
    return NextResponse.json({ error: classifyScriptError(error, diagnosticId) }, { status: error instanceof ScriptPersistenceError ? error.status : error instanceof ReelBudgetExceededError ? 409 : 500 });
  }
}

// Guarda ediciones manuales del guion (texto/búsqueda visual por escena)
// hechas por el usuario en la pantalla de revisión.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  const { videoRequest, response } = await loadOwnedRequest(id, user.id);
  if (!videoRequest) return response!;

  if (videoRequest.status !== "script_ready") {
    return NextResponse.json(
      { error: `La solicitud está en estado "${videoRequest.status}", no se puede editar` },
      { status: 409 },
    );
  }

  const body = (await request.json().catch(() => null)) as GeneratedScript | null;
  if (!body?.title || !Array.isArray(body.segments) || body.segments.length === 0) {
    return NextResponse.json({ error: "Guion inválido" }, { status: 400 });
  }
  // Topes defensivos: el guion editado alimenta directamente la síntesis
  // de voz (costo por carácter) y el render — sin límite, una edición
  // manual podría inflar el costo/duración muy por encima de lo que la
  // solicitud original pidió.
  if (body.segments.length > MAX_SEGMENTS) {
    return NextResponse.json(
      { error: `El guion no puede tener más de ${MAX_SEGMENTS} escenas` },
      { status: 400 },
    );
  }
  for (const segment of body.segments) {
    if (typeof segment.text !== "string" || typeof segment.visualQuery !== "string") {
      return NextResponse.json({ error: "Guion inválido" }, { status: 400 });
    }
    if (segment.text.length > MAX_SCENE_TEXT_LENGTH) {
      return NextResponse.json(
        { error: `El texto de una escena no puede superar ${MAX_SCENE_TEXT_LENGTH} caracteres` },
        { status: 400 },
      );
    }
    if (segment.visualQuery.length > MAX_VISUAL_QUERY_LENGTH) {
      return NextResponse.json(
        { error: `La búsqueda visual no puede superar ${MAX_VISUAL_QUERY_LENGTH} caracteres` },
        { status: 400 },
      );
    }
  }

  if ((videoRequest.script_json as GeneratedScript | null)?.lengthReviewRequired) {
    const note = scriptLengthReview(body, videoRequest.duration_seconds);
    if (note) return NextResponse.json({ error: note }, { status: 422 });
  }
  // A client cannot unset the marker without passing the check against the stored draft.
  delete body.lengthReviewRequired;
  const service = createServiceClient();
  try {
    await persistScriptChange(service, videoRequest, { script_json: body, error_message: null });
  } catch (error) {
    if (error instanceof ScriptPersistenceError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  return NextResponse.json({ status: "script_ready", script: body });
}
