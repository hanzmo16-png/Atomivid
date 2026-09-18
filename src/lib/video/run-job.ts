import { createServiceClient } from "@/lib/supabase/service";
import { generateVideoFromScript } from "./generate-video";
import { generateAvatarVideo } from "./avatar/pipeline";
import type { GeneratedScript, ScriptLanguage } from "@/lib/providers/types";
import type { RenderStage } from "./stages";

type JobRow = {
  status: string;
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
export async function runRenderJob(requestId: string): Promise<void> {
  const service = createServiceClient();

  const { data: row } = await service
    .from("video_requests")
    .select(
      "status, user_id, script_json, style, topic, language, duration_seconds, mode, avatar_id, avatar_voice_id, avatar_provider_video_job_id, recorded_audio_path",
    )
    .eq("id", requestId)
    .single<JobRow>();

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
  if (!row.script_json) {
    await service
      .from("video_requests")
      .update({
        status: "failed",
        error_message: "No hay guion guardado para renderizar.",
        progress_stage: null,
      })
      .eq("id", requestId);
    return;
  }

  const mode = row.mode ?? "visual";
  if (mode === "avatar" && !row.avatar_id) {
    await service
      .from("video_requests")
      .update({ status: "failed", error_message: "Solicitud en modo avatar sin avatar_id asociado.", progress_stage: null })
      .eq("id", requestId);
    return;
  }

  const onProgress = async (stage: RenderStage) => {
    await service.from("video_requests").update({ progress_stage: stage }).eq("id", requestId);
  };

  try {
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
            script: row.script_json,
            style: row.style ?? undefined,
            topic: row.topic ?? undefined,
            language: row.language ?? undefined,
            targetDurationSeconds: row.duration_seconds ?? undefined,
            onProgress,
          });

    await service
      .from("video_requests")
      .update({
        status: "completed",
        video_path: videoPath,
        progress_stage: null,
        error_message: null,
      })
      .eq("id", requestId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";

    await service
      .from("video_requests")
      .update({ status: "failed", error_message: message, progress_stage: null })
      .eq("id", requestId);

    throw error;
  }
}
