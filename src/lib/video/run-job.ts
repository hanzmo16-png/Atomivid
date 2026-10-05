import { createServiceClient } from "@/lib/supabase/service";
import { generateVideoFromScript } from "./generate-video";
import { generateAvatarVideo } from "./avatar/pipeline";
import {
  generateLongFormVideoFromScript,
  isLongFormScriptJson,
  type LongFormScriptBeatInput,
} from "./long-form/produce";
import type { LongFormStage } from "./long-form/stages";
import { resolveExecutablePlan, type ProductionPlan } from "./long-form/production-plan";
import type { GeneratedScript, ScriptLanguage } from "@/lib/providers/types";
import { attemptState } from "./attempt-state";
import type { RenderStage } from "./stages";
import { generateDiagnosticId } from "./render-error";
import { ProviderConfigurationError } from "@/lib/providers/production";
import { isCustomerSafeError } from "./long-form/output-policy";
import { getVoiceProvider } from "@/lib/providers/voice";
import { getPricingConfig } from "@/lib/billing/pricing";
import {
  acquireCapacityHolds,
  CapacityUnavailableError,
  releaseOpenHoldsForRequest,
  settleCapacityHolds,
  supabaseCapacityHoldStore,
  type AcquiredHold,
  type CapacityDemand,
} from "@/lib/paid-calls/capacity-hold";
import { snapshotBalancePort } from "@/lib/paid-calls/capacity-port";
import { readOwnerPilot, assertOwnerPilot } from "@/lib/billing/owner-pilot";
import { readOwnerFormTrial, assertOwnerFormTrial, assertOwnerFormFrozen } from "@/lib/billing/owner-form-trial";
import { ownerFormTrialLedger } from "@/lib/paid-calls/owner-form-trial-ledger";
import { recoveryLedger } from "@/lib/paid-calls/owner-form-recovery";
import { supabaseResultStore } from "@/lib/paid-calls/result-store";
import { getVoiceIdentity } from "@/lib/ai/voice";
import { getFootageProvider } from "@/lib/providers/footage";
import { getMusicProvider } from "@/lib/providers/music";
import { refreshPrepaidPilot } from "@/lib/paid-calls/prepaid-pilot";
import { loadReelLogo } from "./reel-logo";

/**
 * Demanda de capacidad de proveedor de este trabajo (PI V2 B2, RB-02): hoy solo la voz
 * (ElevenLabs, en caracteres de narración). Sin narración pagada (fixture, audio grabado) no
 * hay demanda. Imágenes/video quedan fuera de esta fase.
 */
export function capacityDemandsFor(row: Pick<JobRow, "mode" | "script_json" | "recorded_audio_path">, voiceProviderName: string): CapacityDemand[] {
  if (voiceProviderName === "fixture") return [];
  const mode = row.mode ?? "visual";
  if (mode === "avatar" && row.recorded_audio_path) return [];
  const script = row.script_json as unknown;
  let text = "";
  if (mode === "long_form" && isLongFormScriptJson(script)) {
    text = (script as { beats: LongFormScriptBeatInput[] }).beats.map((b) => b.narration ?? "").join(" ");
  } else if (script && typeof script === "object" && Array.isArray((script as GeneratedScript).segments)) {
    text = (script as GeneratedScript).segments.map((s) => s.text).join(" ");
  }
  const units = text.length;
  if (units <= 0) return [];
  return [{ provider: voiceProviderName, units, usd: (units / 1000) * getPricingConfig().elevenLabsUsdPer1kChars }];
}

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
  recorded_audio_path: string | null;
  avatar_narration_source: string | null;
  avatar_provider_video_job_id: string | null;
  long_form_production_plan: ProductionPlan | null;
  long_form_confirmed_at: string | null;
  brand_logo_path: string | null;
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
  const service = createServiceClient();

  const { data: row, error: readError } = await service
    .from("video_requests")
    .select(
      "status, render_attempts, progress_stage, user_id, script_json, style, topic, language, duration_seconds, mode, avatar_id, avatar_voice_id, avatar_provider_video_job_id, recorded_audio_path, avatar_narration_source, long_form_production_plan, long_form_confirmed_at, brand_logo_path",
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

  // Reserva atómica de capacidad del proveedor ANTES de que el trabajo llegue a la puerta de
  // llamadas pagadas (PI V2 B2, RB-02): saldo desconocido o lectura fallida = no empieza.
  const holdStore = supabaseCapacityHoldStore(service);
  let holds: AcquiredHold[] = [];
  try {
    const pilot = await readOwnerPilot(service, requestId);
    const trial = await readOwnerFormTrial(service, requestId);
    if (process.env.OWNER_FORM_TRIAL_WORKER === "true" && !trial) throw new Error("OWNER_FORM_TRIAL_GRANT_MISSING");
    if (trial) {
      // Only the isolated one-request Actions process may change these settings.
      if (process.env.OWNER_FORM_TRIAL_WORKER !== "true" || !process.env.GITHUB_ACTIONS)
        throw new Error("OWNER_FORM_TRIAL_REQUIRES_ISOLATED_WORKER");
      const { data: auth, error } = await service.auth.admin.getUserById(row.user_id);
      if (error || !auth.user) throw new Error("OWNER_FORM_TRIAL_OWNER_UNVERIFIED");
      assertOwnerFormTrial(trial, { ...row, id: requestId, mode }, auth.user, "worker");
      await assertOwnerFormFrozen(service, trial, row.script_json as GeneratedScript);
      const voice = getVoiceIdentity("es");
      if (voice.voiceId !== trial.voiceId || voice.modelId !== trial.voiceModel
        || getVoiceProvider().name !== "elevenlabs" || getPricingConfig().elevenLabsUsdPer1kChars !== 0.1
        || getFootageProvider().name !== "pexels-video-first" || getMusicProvider().name !== "curated-library"
        || process.env.OPENAI_IMAGE_ESTIMATED_COST_USD !== "0.08" || process.env.OPENAI_IMAGE_MODEL !== "gpt-image-2"
        || process.env.OPENAI_IMAGE_SIZE !== "1024x1536" || process.env.OPENAI_IMAGE_QUALITY !== "medium")
        throw new Error("OWNER_FORM_TRIAL_PROVIDER_CONTRACT_CHANGED");
      await refreshPrepaidPilot(service, trial);
      process.env.REEL_VISUAL_RELEVANCE_ENABLED = "true";
      process.env.OPENAI_IMAGE_GENERATION_ENABLED = "true";
      process.env.IMAGE_PROVIDER = "openai";
      process.env.MAX_GENERATED_IMAGES_PER_VIDEO = String(trial.maxImages);
      process.env.MAX_VISUAL_COST_USD = String(trial.maxImages * trial.maxImageReservationUsd);
    }
    let trialLedger = trial ? ownerFormTrialLedger(service, trial) : undefined;
    if (process.env.OWNER_FORM_RECOVERY_WORKER === "true") {
      if (!trial || !trialLedger) throw new Error("RECOVERY_TRIAL_REQUIRED");
      trialLedger = await recoveryLedger(service, trial, trialLedger);
    }
    if (pilot) {
      const { data: auth, error } = await service.auth.admin.getUserById(row.user_id);
      if (error || !auth.user) throw new Error("PILOT_OWNER_UNVERIFIED");
      assertOwnerPilot(pilot, { ...row, id: requestId }, auth.user, "worker");
      await refreshPrepaidPilot(service, pilot);
    }
    if (mode === "avatar" && !row.avatar_id) throw new Error("Falta el avatar asociado a esta solicitud.");
    if (mode !== "long_form" && !row.script_json) throw new Error("No hay guion guardado para renderizar.");
    if (mode === "long_form" && !isLongFormScriptJson(row.script_json)) {
      throw new Error("El guion guardado no tiene la forma esperada para Long Form (topic + beats[] con narración).");
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
    const customerLogoUrl = mode === "visual" ? await loadReelLogo(service, row.user_id, requestId, row.brand_logo_path) : undefined;
    const baseDemands = capacityDemandsFor(row, getVoiceProvider().name);
    const demands = pilot ? baseDemands.map(d => ({ ...d, units: pilot.maxVoiceCharacters * pilot.maxVoiceCalls, usd: 0 }))
      : trial ? baseDemands.map(d => ({ ...d, units: trial.maxVoiceCharacters * trial.maxVoiceCalls, usd: 0.2 })) : baseDemands;
    if (demands.length > 0) {
      await releaseOpenHoldsForRequest(holdStore, requestId).catch(() => 0);
      const admission = await acquireCapacityHolds({ store: holdStore, balance: snapshotBalancePort(service) }, { requestId, demands });
      if (!admission.acquired) throw new CapacityUnavailableError(admission.provider, admission.reason);
      holds = admission.holds;
    }
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
              runtime: { attempt: row.render_attempts },
            })
          : await generateVideoFromScript({
              supabase: service,
              requestId,
              artifactPrefix: `${requestId}/attempt-${row.render_attempts}`,
              script: row.script_json as GeneratedScript,
              style: row.style ?? undefined,
              topic: row.topic ?? undefined,
              language: row.language ?? undefined,
              targetDurationSeconds: row.duration_seconds ?? undefined,
              onProgress,
              ownerPilot: pilot ?? undefined,
              ...(trialLedger ? { paidCalls: { ledger: trialLedger, results: supabaseResultStore(service) }, trialReviewLedger: trialLedger } : {}),
              trialIllustrationOnly: process.env.OWNER_FORM_RECOVERY_WORKER === "true" && process.env.OWNER_FORM_RECOVERY_STAGE === "compact-final",
              customerLogoUrl,
            });

    const completed = await update({
      status: "completed", video_path: videoPath, progress_stage: null, long_form_stage: null, long_form_progress: null, error_message: null,
    }).select("id").maybeSingle();
    if (completed.error || !completed.data) throw new Error("No se pudo confirmar el resultado de este intento. No vuelvas a generar sin revisar su estado.");
    // Consumo real: la reserva pasa a COMMITTED (sigue descontando hasta una instantánea más nueva).
    await settleCapacityHolds(holdStore, holds, "COMMITTED").catch(() => undefined);
  } catch (error) {
    // Cualquier fallo tras la admisión puede haber consumido unidades: se conserva como COMMITTED.
    if (holds.length > 0) await settleCapacityHolds(holdStore, holds, "COMMITTED").catch(() => undefined);
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
    const detail = safe ? safe.customerMessage : error instanceof Error ? error.message : "Error desconocido";
    const rawMessage = mode === "long_form" ? scrubInternalPaths(detail) : detail;
    const message = `${rawMessage} (Código: ${diagnosticId})`;

    // QA real (2026-09-25, "HEYGEN PROVIDER CONFIG INCOMPLETE"): el
    // mensaje genérico de ProviderConfigurationError nunca dice qué
    // variable falta (a propósito, nunca llega al usuario) — sin esto, ni
    // siquiera soporte podía saber si faltaba HEYGEN_API_KEY, DID_API_KEY,
    // etc. sin adivinar. Se registra SOLO el/los nombres (nunca valores),
    // correlacionado con el mismo diagnosticId ya añadido a error_message.
    // Admisión de capacidad rechazada (RB-02): la causa exacta (proveedor, saldo, unidades) va al
    // log con el mismo código; al usuario solo le llega el mensaje seguro.
    if (error instanceof CapacityUnavailableError) {
      console.error(`[atomivid:capacity] (Código: ${diagnosticId}) ${error.provider}: ${error.detail}`);
    }
    if (error instanceof ProviderConfigurationError && error.missingEnvVars.length > 0) {
      console.error(
        `[atomivid:provider-config] (Código: ${diagnosticId}) variables faltantes: ${error.missingEnvVars.join(", ")}`,
      );
    }

    await update({ status: "failed", error_message: message, progress_stage: null, long_form_stage: null, long_form_progress: null });

    throw error;
  }
}
