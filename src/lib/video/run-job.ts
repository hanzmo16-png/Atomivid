import { createServiceClient } from "@/lib/supabase/service";
import { generateVideoFromScript } from "./generate";
import type { GeneratedScript } from "@/lib/providers/types";
import type { RenderStage } from "./stages";

type JobRow = {
  status: string;
  script_json: GeneratedScript | null;
  style: string | null;
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
    .select("status, script_json, style")
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

  try {
    const { videoPath } = await generateVideoFromScript({
      supabase: service,
      requestId,
      script: row.script_json,
      style: row.style ?? undefined,
      onProgress: async (stage: RenderStage) => {
        await service.from("video_requests").update({ progress_stage: stage }).eq("id", requestId);
      },
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
