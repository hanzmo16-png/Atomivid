import { createServiceClient } from "@/lib/supabase/service";
import { generateVideoFromScript } from "./generate-video";
import { generateAvatarVideo } from "./avatar/pipeline";
import type { GeneratedScript, ScriptLanguage } from "@/lib/providers/types";
import { attemptState } from "./attempt-state";
import type { RenderStage } from "./stages";

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
  avatar_provider_video_job_id: string | null;
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
      "status, render_attempts, progress_stage, user_id, script_json, style, topic, language, duration_seconds, mode, avatar_id, avatar_voice_id, avatar_provider_video_job_id, recorded_audio_path",
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

  try {
    if (!row.script_json) throw new Error("No hay guion guardado para renderizar.");
    if (mode === "avatar" && !row.avatar_id) throw new Error("Falta el avatar asociado a esta solicitud.");
    const { videoPath } =
      mode === "avatar"
        ? await generateAvatarVideo({
            supabase: service,
            requestId,
            userId: row.user_id,
            script: row.script_json,
            avatarId: row.avatar_id as string,
            voiceId: row.avatar_voice_id ?? undefined,
            recordedAudioPath: row.recorded_audio_path,
            language: row.language ?? undefined,
            existingProviderVideoJobId: row.avatar_provider_video_job_id,
            onProgress,
          })
        : await generateVideoFromScript({
            supabase: service,
            requestId,
            artifactPrefix: `${requestId}/attempt-${row.render_attempts}`,
            script: row.script_json,
            style: row.style ?? undefined,
            topic: row.topic ?? undefined,
            language: row.language ?? undefined,
            targetDurationSeconds: row.duration_seconds ?? undefined,
            onProgress,
          });

    const completed = await update({
      status: "completed", video_path: videoPath, progress_stage: null, error_message: null,
    }).select("id").maybeSingle();
    if (completed.error || !completed.data) throw new Error("No se pudo confirmar el resultado de este intento. No vuelvas a generar sin revisar su estado.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";

    await update({ status: "failed", error_message: message, progress_stage: null });

    throw error;
  }
}
