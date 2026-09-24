/**
 * Envoltorio de idempotencia/durabilidad para CUALQUIER VideoProvider real
 * (Veo/Runway/Kling) — RC Phase 1, item "worker abstraction". Antes de
 * esto, un retry de render (nuevo render_attempts tras un fallo posterior
 * en el pipeline, p. ej. el ensamblado Remotion o la subida final) volvía
 * a llamar a resolveAiVideoForShot() para CADA shot "ai_video" del
 * documental sin memoria del intento anterior — si un clip de Veo ya se
 * había pagado y generado con éxito, un fallo más adelante en el MISMO
 * render_attempt lo perdía, y el siguiente intento lo volvía a pagar. Ver
 * mission section 10/17: "en NINGÚN caso debe perderse un asset ya pagado
 * innecesariamente" / "nunca regenerar un asset pagado si existe un
 * providerJobId recuperable o una salida ya persistida válida".
 *
 * Reutiliza el mecanismo durable YA construido y probado en P2A/P2B
 * (ai-video-storage.ts: registro STARTED/COMPLETED en Supabase Storage,
 * idempotente por checksum) en vez de inventar un mecanismo nuevo — este
 * módulo solo lo conecta a la frontera VideoProvider.generateVideo(), para
 * que ai-video-resolver.ts/asset-resolver.ts no necesiten saber que existe
 * (cero cambios ahí).
 *
 * Clave de idempotencia: shotId (via request.metadata.shotId, que
 * ai-video-prompt-builder.ts ya adjunta a toda VideoGenerationRequest)
 * dentro de `scopeId` (el requestId de video_requests) — nunca colisiona
 * entre dos videos ni entre dos shots del mismo video. Sin shotId en la
 * metadata no hay forma segura de deduplicar — se delega sin envoltura en
 * vez de inventar una clave que pudiera colisionar entre llamadas.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GenerativeAsset, VideoGenerationRequest, VideoProvider } from "@/lib/providers/types";
import {
  AI_VIDEO_STORAGE_BUCKET,
  readAiVideoClipRecord,
  resolveAiVideoStorageAsset,
  validateExistingAiVideoClip,
} from "./ai-video-storage";
import type { ResolvedAiVideoClip } from "./ai-video-resolver";

export function wrapDurableVideoProvider(
  inner: VideoProvider,
  opts: { supabase: SupabaseClient; scopeId: string; executionMode?: "simulation" | "real" },
): VideoProvider {
  const executionMode = opts.executionMode ?? "real";

  return {
    name: inner.name,
    capabilities: inner.capabilities,
    isAvailable: () => inner.isAvailable(),
    async generateVideo(request: VideoGenerationRequest): Promise<GenerativeAsset> {
      const shotId = request.metadata?.shotId;
      if (!shotId) return inner.generateVideo(request);

      const existing = await readAiVideoClipRecord(opts.supabase, AI_VIDEO_STORAGE_BUCKET, opts.scopeId, shotId);
      if (
        existing?.status === "COMPLETED" &&
        (await validateExistingAiVideoClip(opts.supabase, AI_VIDEO_STORAGE_BUCKET, existing))
      ) {
        const { data, error } = await opts.supabase.storage
          .from(AI_VIDEO_STORAGE_BUCKET)
          .download(existing.storagePath!);
        if (error || !data) {
          throw new Error(
            `wrapDurableVideoProvider: el shot "${shotId}" tiene un clip COMPLETED registrado pero no se pudo ` +
              `descargar de Storage ("${existing.storagePath}"): ${error?.message ?? "desconocido"}. No se genera ` +
              `de nuevo en silencio — revisa el bucket antes de reintentar.`,
          );
        }
        const buffer = Buffer.from(await data.arrayBuffer());
        return {
          buffer,
          mimeType: existing.mimeType ?? "video/mp4",
          extension: existing.extension ?? "mp4",
          width: existing.widthPx,
          height: existing.heightPx,
          durationSeconds: existing.durationSeconds,
          model: existing.model ?? inner.name,
          // Ya se pagó en el intento anterior (existing.costUsd) — reutilizar
          // un clip persistido NUNCA se vuelve a contar como gasto nuevo.
          costUsd: 0,
          providerJobId: existing.providerJobId,
        };
      }

      const asset = await inner.generateVideo(request);
      const clip: ResolvedAiVideoClip = {
        shotId,
        buffer: asset.buffer,
        mimeType: asset.mimeType,
        extension: asset.extension,
        durationSeconds: asset.durationSeconds ?? request.durationSeconds,
        widthPx: asset.width,
        heightPx: asset.height,
        provider: inner.name,
        model: asset.model,
        costUsd: asset.costUsd,
        providerJobId: asset.providerJobId,
        sourceHasGeneratedAudio: asset.sourceHasGeneratedAudio,
      };
      await resolveAiVideoStorageAsset(opts.supabase, clip, {
        scopeId: opts.scopeId,
        idempotencyKey: shotId,
        executionMode,
      });
      return asset;
    },
  };
}
