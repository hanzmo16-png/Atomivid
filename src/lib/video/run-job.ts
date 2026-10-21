import { supplyGuardRequired } from "@/lib/supply/server";
import { classifyPaidFailure, isRenderEngineFailure, RENDER_ENGINE_CUSTOMER_MESSAGE } from "./render-engine-error";
import { isInternalProductionOwner } from "@/lib/billing/internal-production";
import { MAX_DIRECTOR_MATERIAL_USD } from "@/lib/video/director/material-fill";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { needsNarrationEdit } from "./duration-check";
import { DeliverableUnverifiedError } from "@/lib/video/deliverable-check";
import { getVoiceProvider } from "@/lib/providers/voice";
import { editorialApprovalError } from "./long-form/editorial";
import { loadReelRecraft, recraftDemandUsd, signReferenceUrls, persistReelStyleId, loadStyleMissing, persistStyleMissing } from "@/lib/video/recraft-reel-server";
import { getRecraftImageProvider } from "@/lib/providers/image";
import { recraftAllowedFor, RecraftAccessError } from "@/lib/video/recraft-access";
import { ChosenImageProviderError } from "@/lib/video/long-form/shot-executor";
import { RecraftStyleMissingError } from "@/lib/video/recraft-reel";
import { jobSupplyDemands, reserveJobSupply, releaseUnusedJobSupply, JobEnvelopeMismatchError, JobEnvelopeExhaustedError } from "@/lib/supply/job";
import { withSupplyContext } from "@/lib/supply/anthropic";
import { SupplyUnavailableError } from "@/lib/supply/policy";
import { ReelBudgetExceededError } from "@/lib/supply/reel-budget";
import { createServiceClient } from "@/lib/supabase/service";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordMarketingEvent } from "@/lib/marketing/events";
import { generateVideoFromScript } from "./generate-video";
import { AvatarPipelineError, generateAvatarVideo } from "./avatar/pipeline";
import {
  generateLongFormVideoFromScript,
  isLongFormScriptJson,
  type LongFormScriptBeatInput,
} from "./long-form/produce";
import type { LongFormStage } from "./long-form/stages";
import { resolveExecutablePlan, type ProductionPlan } from "./long-form/production-plan";
import { assertCinematicV6Account } from "./long-form/cinematic-v6-access";
import { decideDirectorRender, DirectorUnavailableError } from "./director/render-access";
import { footageProviderLicense } from "./director/beat-license";
import { directorReelPreflight, DirectorPreflightBlockedError } from "./director/data-card";
import { getFootageProvider } from "@/lib/providers/footage";
import type { GeneratedScript, ScriptLanguage } from "@/lib/providers/types";
import { attemptState } from "./attempt-state";
import type { RenderStage } from "./stages";
import { generateDiagnosticId } from "./render-error";
import { ProviderConfigurationError } from "@/lib/providers/production";
import { isCustomerSafeError } from "./long-form/output-policy";
import { isServiceConfigurationError, scrubInternalNames, SERVICE_CONFIGURATION_MESSAGE } from "./customer-error";
import { encodeStoredFailure } from "./failure-action";

/** Rutas internas de Storage (`<uuid>/...`) nunca llegan al mensaje visible de Long Form. */
export function scrubInternalPaths(message: string): string {
  return message.replace(/\b(?:long-form\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/[^\s:,;)]*)?/gi, "(archivo interno)");
}

type JobRow = {
  status: string;
  render_attempts: number;
  progress_stage: string | null;
  user_id: string;
  script_json: GeneratedScript | null;
  style: string | null;
  topic: string | null;
  language: ScriptLanguage | null;
  duration_seconds: number | null;
  mode: string | null;
  avatar_id: string | null;
  avatar_voice_id: string | null;
  reel_voice_id?: string | null;
  recorded_audio_path: string | null;
  avatar_narration_source: string | null;
  avatar_provider_video_job_id: string | null;
  long_form_production_plan: ProductionPlan | null;
  long_form_confirmed_at: string | null;
  /** T-34 B3: whether the web requested the Director for this attempt (migration 20261017140000). */
  director_requested?: boolean | null;
};

/**
 * Corre el resto del pipeline (voz/footage/música/render/subida) para una
 * solicitud que ya está en estado "processing", y deja el resultado
 * (completed/failed) en Supabase. La usan ambos workers:
 *
 * - El worker "inline" la llama directamente, en el mismo proceso que
 *   respondió la request HTTP (fallback de desarrollo, ver
 *   src/lib/worker/inline.ts).
 * - `scripts/render-worker.ts` la llama desde el job de GitHub Actions,
 *   fuera de Next.js por completo.
 *
 * Así el pipeline de render vive en un solo lugar sin importar qué worker
 * lo ejecuta — sustituir GitHub Actions por otro worker (p. ej. Remotion
 * Lambda) más adelante no requiere reescribir esta lógica.
 */
export async function runRenderJob(requestId: string, expectedAttempt?: number): Promise<void> {
  return withSupplyContext(requestId, () => runRenderJobWithSupply(requestId, expectedAttempt));
}
async function runRenderJobWithSupply(requestId: string, expectedAttempt?: number): Promise<void> {
  const service = createServiceClient();

  const { data: row, error: readError } = await service
    .from("video_requests")
    .select(
      "status, render_attempts, progress_stage, user_id, script_json, style, topic, language, duration_seconds, mode, avatar_id, avatar_voice_id, avatar_provider_video_job_id, recorded_audio_path, avatar_narration_source, long_form_production_plan, long_form_confirmed_at, director_requested, reel_voice_id",
    )
    .eq("id", requestId)
    .single<JobRow>();

  if (readError) throw new Error("No se pudo consultar el estado del trabajo.");
  if (!row) {
    console.warn(`runRenderJob: solicitud ${requestId} no existe, se ignora.`);
    return;
  }

  // Guarda de idempotencia: si el estado ya no es "processing" (porque un
  // dispatch duplicado o desfasado llega después de que otro worker ya
  // completó/falló esta misma solicitud), no la vuelvas a procesar — evita
  // un render duplicado y una subida duplicada.
  if (row.status !== "processing") {
    console.warn(
      `runRenderJob: solicitud ${requestId} ya no está en "processing" (está en "${row.status}"), se ignora.`,
    );
    return;
  }
  if (expectedAttempt !== undefined && row.render_attempts !== expectedAttempt) return;
  const { claim, update } = attemptState(service, {requestId, userId: row.user_id, attempt: row.render_attempts});
  if (!await claim(row.progress_stage)) return;

  const mode = row.mode ?? "visual";
  const onProgress = async (stage: RenderStage) => {
    const result = await update({ progress_stage: stage }).select("id").maybeSingle();
    if (result.error || !result.data) throw new Error("El trabajo ya no tiene una reserva activa. No se repetirá automáticamente.");
  };
  // Long Form tiene su propio vocabulario de etapas (columna long_form_stage,
  // migración 0016) — nunca se reutiliza progress_stage para esto, ver el
  // comentario de esa migración. progress_stage sigue recibiendo "voice" vía
  // claim()/attemptState de abajo: eso solo actúa como el cerrojo de
  // concurrencia interno del intento, nunca se muestra al usuario para
  // mode="long_form" (Historial lee long_form_stage para esta modalidad).
  // Cada escritura es también un latido (updatedAt): render-guard.ts solo
  // considera colgado un Long Form sin latidos recientes, nunca uno que
  // simplemente tarda. stageStartedAt permite un ETA derivado SOLO del
  // ritmo observado en esta etapa (ver progress.ts).
  let progressStage: LongFormStage | null = null;
  let stageStartedAt = "";
  const onLongFormProgress = async (stage: LongFormStage, units?: { completed: number; total: number; label: string }) => {
    const now = new Date().toISOString();
    if (stage !== progressStage) {
      progressStage = stage;
      stageStartedAt = now;
    }
    const long_form_progress = {
      stage,
      unitsCompleted: units?.completed ?? 0,
      unitsTotal: units?.total ?? 0,
      unitLabel: units?.label ?? "",
      updatedAt: now,
      stageStartedAt,
    };
    const result = await update({ long_form_stage: stage, long_form_progress }).select("id").maybeSingle();
    if (result.error || !result.data) throw new Error("El trabajo ya no tiene una reserva activa. No se repetirá automáticamente.");
  };

  try {
    if (mode === "avatar" && !row.avatar_id) throw new Error("Falta el avatar asociado a esta solicitud.");
    if (mode !== "long_form" && !row.script_json) throw new Error("No hay guion guardado para renderizar.");
    if (mode === "long_form" && !isLongFormScriptJson(row.script_json)) {
      throw new Error("El guion guardado no tiene la forma esperada para Long Form (topic + beats[] con narración).");
    }
    if (mode === "long_form" && isLongFormScriptJson(row.script_json)) {
      const editorialError = editorialApprovalError(row.script_json);
      if (editorialError) throw new Error(editorialError);
    }
    // Defensa en profundidad (además de la puerta de render/route.ts): sin
    // confirmación humana, con un plan inválido/de versión desconocida, o
    // con un guion distinto al confirmado, no se ejecuta NADA pagado.
    const longFormPlan: ProductionPlan | null =
      mode === "long_form"
        ? resolveExecutablePlan({
            confirmedAt: row.long_form_confirmed_at,
            plan: row.long_form_production_plan,
            beats: (row.script_json as unknown as { beats: LongFormScriptBeatInput[] }).beats,
          })
        : null;
    // Cinematic V6: la cuenta dueña del trabajo se vuelve a comprobar aquí (falla cerrado), antes de reservar nada.
    await assertCinematicV6Account(longFormPlan, async () => {
      const { data, error } = await service.auth.admin.getUserById(row.user_id);
      if (error) throw error;
      return data.user;
    });
    // Director (chatgpt-06, T-34 B3): decided BEFORE reserving or paying, from the attempt's stored request
    // (`director_requested`, written by the web) and the worker's own switch, pilot list and owner account; never from
    // the dispatch payload. Requested but not applicable here ⇒ DirectorUnavailableError, never a silent classic montage.
    let requestOwner: Parameters<typeof isInternalProductionOwner>[0] | null = null;
    const directorRender = mode === "visual" && await decideDirectorRender(row, async () => {
      const { data, error } = await service.auth.admin.getUserById(row.user_id);
      if (error) throw error;
      requestOwner = data.user;
      return data.user;
    });
    // Anexo C1: new Director material only for the owner's private tests (same check the render route applied
    // when it reserved the approved ceiling). Nothing from the dispatch payload decides it.
    const ownerTest = directorRender && requestOwner !== null && isInternalProductionOwner(requestOwner);
    if (mode === "visual") console.log("[atomivid:director]", JSON.stringify({ requestId, directorRequested: row.director_requested === true, directorRender }));
    // T36 C1: the configured material provider's licence is known before anything is reserved or paid; if the
    // Director would have to render material without a reviewed licence, stop here (no narration, no reservation).
    if (directorRender && footageProviderLicense(getFootageProvider()) !== "CLEARED") throw new DirectorUnavailableError("material_license_not_cleared");
    // T42: sentences the Director cannot honour in a Reel stop HERE, before narration or any reservation; the request
    // goes back to the script editor with the sentence to change (see the catch below). Nothing is spent.
    if (directorRender) {
      const preflight = directorReelPreflight(row.script_json as GeneratedScript);
      if (preflight.blockers.length) throw new DirectorPreflightBlockedError(preflight.blockers);
    }
    // «Imágenes IA con Recraft» (Reel and Long Form): read in its own query (works before the migration), revalidated
    // here against the DB row, the confirmed plan and the owning account, with FAL_KEY checked BEFORE any reservation
    // or paid voice. A Recraft video never falls back to stock/fixture/other-provider images.
    const recraft = mode === "visual" || mode === "long_form" ? await loadReelRecraft(service, requestId) : null;
    if (mode === "long_form" && (longFormPlan?.providers.image === "recraft") !== Boolean(recraft)) throw new RecraftAccessError("plan_mismatch");
    if (recraft) {
      const { data: ownerData, error: ownerError } = await service.auth.admin.getUserById(row.user_id);
      if (ownerError) throw ownerError;
      if (!recraftAllowedFor(ownerData.user)) throw new RecraftAccessError();
      getRecraftImageProvider();
    }
    await reserveJobSupply(service, requestId, row.render_attempts, jobSupplyDemands(row, getVoiceProvider().name, undefined, { recraftUsd: mode === "visual" ? recraftDemandUsd(recraft, row.script_json) : 0 }));
    const { videoPath } =
      mode === "avatar"
        ? await generateAvatarVideo({
            supabase: service,
            requestId,
            userId: row.user_id,
            script: row.script_json as GeneratedScript,
            avatarId: row.avatar_id as string,
            voiceId: row.avatar_voice_id ?? undefined,
            recordedAudioPath: row.recorded_audio_path,
            narrationSource: row.avatar_narration_source as "own_audio" | "tts" | null,
            language: row.language ?? undefined,
            existingProviderVideoJobId: row.avatar_provider_video_job_id,
            onProgress,
          })
        : mode === "long_form"
          ? await generateLongFormVideoFromScript({
              supabase: service,
              requestId,
              artifactPrefix: `${requestId}/attempt-${row.render_attempts}`,
              topic: (row.script_json as unknown as { topic: string; beats: LongFormScriptBeatInput[] }).topic,
              beats: (row.script_json as unknown as { topic: string; beats: LongFormScriptBeatInput[] }).beats,
              language: row.language ?? undefined,
              plan: longFormPlan as ProductionPlan,
              onProgress: onLongFormProgress,
              runtime: { attempt: row.render_attempts,
                ...(recraft ? { recraftStyle: {
                  styleId: recraft.styleId,
                  // A documentary may reach its first AI image hours after start: references stay signed for 6 h.
                  referenceImageUrls: recraft.styleId ? [] : await signReferenceUrls(service, recraft.style.referencePaths, 6 * 3600),
                  match: recraft.style.match, styleNote: recraft.style.styleNote,
                  onStyleId: (styleId: string) => persistReelStyleId(service, requestId, styleId),
                  onMissingStyleId: recraft.style.onMissingStyleId,
                  styleMissing: recraft.styleId ? false : await loadStyleMissing(service, requestId),
                  onStyleMissing: (providerJobId: string | undefined) => persistStyleMissing(service, requestId, providerJobId),
                } } : {}) },
            })
          : await generateVideoFromScript({
              supabase: service,
              requestId,
              artifactPrefix: `${requestId}/attempt-${row.render_attempts}`,
              script: row.script_json as GeneratedScript,
              style: row.style ?? undefined,
              topic: row.topic ?? undefined,
              language: row.language ?? undefined,
              voiceId: row.reel_voice_id ?? undefined,
              ...(recraft ? { recraft: {
                styleId: recraft.styleId,
                referenceImageUrls: recraft.styleId ? [] : await signReferenceUrls(service, recraft.style.referencePaths),
                match: recraft.style.match, styleNote: recraft.style.styleNote, onMissingStyleId: recraft.style.onMissingStyleId,
                onStyleId: (styleId: string) => persistReelStyleId(service, requestId, styleId),
              } } : {}),
              targetDurationSeconds: row.duration_seconds ?? undefined,
              onProgress,
              directorRender,
              // Anexo C1: the approved ceiling exists only in THIS attempt's image envelope (reserved by the server).
              ...(ownerTest ? { directorMaterialBudgetUsd: () => directorMaterialBudgetUsd(service, requestId, row.render_attempts) } : {}),
            });

    const completed = await update({
      supply_wait_started_at: null, supply_not_before: null,
      status: "completed", video_path: videoPath, progress_stage: null, long_form_stage: null, long_form_progress: null, error_message: null,
    }).select("id").maybeSingle();
    if (completed.error || !completed.data) throw new Error("No se pudo confirmar el resultado de este intento. No vuelvas a generar sin revisar su estado.");
    await releaseUnusedJobSupply(service, requestId, row.render_attempts).catch(() => console.error("[atomivid:supply] unused reservation release unconfirmed"));
    await recordFirstProduction(service, row.user_id);
  } catch (error) {
    if (error instanceof SupplyUnavailableError) {
      // Fixed reason codes only (no amounts/ids): the admission refusal that started this wait.
      console.error(`[atomivid:supply] waiting provider=${error.provider} reason=${error.reason}`);
      const waiting = await update({ progress_stage: "queued", supply_wait_started_at: new Date().toISOString(),
        supply_not_before: new Date(Date.now() + 300_000).toISOString(),
        error_message: "Estamos esperando disponibilidad de producción. Tu solicitud y sus avances están guardados." });
      if (waiting.error) throw new Error("SUPPLY_WAIT_SAVE_FAILED");
      return;
    }
    // Release only unused resources; uncertain paid calls remain charged against the caps.
    await releaseUnusedJobSupply(service, requestId, row.render_attempts).catch(() => undefined);
    // QA real (2026-09-25): un fallo real de avatar (aquí, pipeline.ts
    // rechazando por AVATAR_MODE_ENABLED=false, un desajuste de proveedor,
    // etc.) llegaba a error_message sin ningún código de diagnóstico —
    // renderFailureMessage() (job-error.ts) trata cualquier texto SIN el
    // sufijo "(Código: XXXXXXXX)" como crudo/sin clasificar y lo degrada al
    // genérico "No se pudo completar este intento...", perdiendo la causa
    // real específica que sí estaba guardada en la base de datos — mismo
    // patrón que classifyScriptError/classifyRenderError ya resuelven en
    // otras etapas. Se añade aquí el mismo sufijo para que ese mensaje,
    // que run-job.ts YA compone con cuidado (avatar_not_ready, provider_error,
    // duration_exceeded, etc. en pipeline.ts, o el error real del proveedor
    // de voz/footage/música en generate-video.ts), llegue intacto al
    // usuario/admin en vez de perderse en el bucket genérico.
    // P0 2026-09-25: un fallo de ENTREGA de Long Form (render ya hecho)
    // mostraba "No se pudo subir <uuid>/attempt-1/final.mp4: The object
    // exceeded..." al cliente. Los errores con mensaje seguro
    // (LongFormOutputError) usan ese mensaje y su propio diagnosticId (el
    // mismo que queda en el estado durable de salida, para el admin); y
    // ninguna ruta interna de Storage llega al texto visible de Long Form.
    const safe = isCustomerSafeError(error) ? error : null;
    const diagnosticId = safe?.diagnosticId ?? generateDiagnosticId();
    // Configuration errors name environment variables: the customer gets a plain explanation, the log keeps the cause.
    const configError = !safe && isServiceConfigurationError(error);
    if (configError) console.error(`[atomivid:config] (Código: ${diagnosticId}) ${(error as Error).name}: ${(error as Error).message}`);
    // F2-B: a render-engine failure (Remotion/Chromium/FFmpeg) never reaches the customer verbatim; the log keeps it.
    const engineFailure = !safe && !configError && error instanceof Error && isRenderEngineFailure(error.message);
    if (engineFailure) console.error(`[atomivid:render-engine] (Código: ${diagnosticId}) ${(error as Error).name}: ${(error as Error).message}`);
    // F40 caos: un fallo de llamada de pago incierta (RR) o en curso nunca llega crudo; el log conserva la causa.
    const paidFailure = !safe && !configError && !engineFailure ? classifyPaidFailure(error) : null;
    if (paidFailure) console.error(`[atomivid:paid-uncertain] (Código: ${diagnosticId}) ${(error as Error)?.name}: ${(error as Error)?.message}`);
    const detail = safe ? safe.customerMessage : configError ? SERVICE_CONFIGURATION_MESSAGE
      : engineFailure ? RENDER_ENGINE_CUSTOMER_MESSAGE : paidFailure ? paidFailure
      : error instanceof Error ? scrubInternalNames(error.message) : "Error desconocido";
    const rawMessage = mode === "long_form" ? scrubInternalPaths(detail) : detail;
    const message = `${rawMessage} (Código: ${diagnosticId})`;

    // QA real (2026-09-25, "HEYGEN PROVIDER CONFIG INCOMPLETE"): el
    // mensaje genérico de ProviderConfigurationError nunca dice qué
    // variable falta (a propósito, nunca llega al usuario) — sin esto, ni
    // siquiera soporte podía saber si faltaba HEYGEN_API_KEY, DID_API_KEY,
    // etc. sin adivinar. Se registra SOLO el/los nombres (nunca valores),
    // correlacionado con el mismo diagnosticId ya añadido a error_message.
    if (error instanceof ProviderConfigurationError && error.missingEnvVars.length > 0) {
      console.error(
        `[atomivid:provider-config] (Código: ${diagnosticId}) variables faltantes: ${error.missingEnvVars.join(", ")}`,
      );
    }

    // Typed action stored with the text: a configuration failure needs support, not an immediate retry.
    // Control de costos (2026-10-18): an envelope that does not match or is used up never fixes itself by retrying
    // (a retry would only spend attempts, and possibly money): support reviews it first.
    const action = configError || error instanceof ProviderConfigurationError || error instanceof ReelBudgetExceededError
      || error instanceof JobEnvelopeMismatchError || error instanceof JobEnvelopeExhaustedError || error instanceof DeliverableUnverifiedError
      || (error instanceof DirectorUnavailableError && error.reason !== "owner_lookup_failed")
      // Recraft: an account/plan mismatch or a stop that a retry cannot clear goes to support, never a retry loop.
      || error instanceof RecraftAccessError || error instanceof RecraftStyleMissingError
      || (error instanceof ChosenImageProviderError && !error.retryable) ? "support" : "retry";
    // A measured duration mismatch happens before footage/render and after the
    // voice ledger is settled. Reopen editing; retain attempts and paid history.
    // T-24 C1: same for an Avatar narrated from the script whose REAL audio exceeds the limit (no avatar job was
    // requested): reopen the script with the duration cause, never leave the request failed and unrecoverable.
    const avatarNarrationTooLong = mode === "avatar" && error instanceof AvatarPipelineError && error.code === "duration_exceeded"
      && !row.avatar_provider_video_job_id && !row.recorded_audio_path && !row.avatar_narration_source;
    // T42: a Director preflight block happened before narration: reopen the script with the explanation (no spend).
    const editNarration = needsNarrationEdit(error, mode) || avatarNarrationTooLong || (mode === "visual" && error instanceof DirectorPreflightBlockedError);
    const failed = await update({ status: editNarration ? "script_ready" : "failed", error_message: encodeStoredFailure(message, action), progress_stage: null, long_form_stage: null, long_form_progress: null }).select("id").maybeSingle();
    if (failed.error || !failed.data) throw new Error("No se pudo guardar el resultado del intento.");
    if (editNarration) return;

    throw error;
  }
}

/**
 * Funnel measurement: the account's FIRST finished video (counted once per account; a later video, a
 * retry or a recovery never counts again). Best effort: it can never fail or delay a delivered video.
 */
async function recordFirstProduction(service: SupabaseClient, userId: string) {
  try {
    const { count, error } = await service.from("video_requests").select("id", { count: "exact", head: true })
      .eq("user_id", userId).eq("status", "completed");
    if (error || count !== 1) return;
    await recordMarketingEvent(service, { event: "first_production_completed", dedupeKey: `first_production_completed:${userId}`, userId });
  } catch { /* measurement only */ }
}

/**
 * Anexo C1: the new Director material this attempt may still buy, from its own image-provider envelope only (the
 * durable, server-made reservation; never the dispatch). The owner's approved ceiling is what the render route added
 * on top of the Reel's normal image cap (jobSupplyDemands), so: min(reserved − normal cap, reserved − consumed). No
 * supply guard, an unreadable or closed envelope, or no surplus = 0 — never «unlimited».
 */
async function directorMaterialBudgetUsd(service: ReturnType<typeof createServiceClient>, requestId: string, attempt: number): Promise<number> {
  if (!supplyGuardRequired()) return 0;
  const flags = getFeatureFlags();
  const { data, error } = await service.from("pi_supply_job_reservations").select("reserved_usd, consumed_usd, status")
    .eq("project_id", requestId).eq("render_attempt", attempt).eq("provider", flags.imageProvider).maybeSingle<{ reserved_usd: number; consumed_usd: number; status: string }>();
  if (error || !data || data.status !== "OPEN") return 0;
  const reserved = Number(data.reserved_usd), consumed = Number(data.consumed_usd);
  if (!Number.isFinite(reserved) || !Number.isFinite(consumed)) return 0;
  const approved = reserved - (flags.imageGenerationEnabled ? flags.maxVisualCostUsd : 0);
  return Math.max(0, Math.min(approved, reserved - consumed, MAX_DIRECTOR_MATERIAL_USD));
}
