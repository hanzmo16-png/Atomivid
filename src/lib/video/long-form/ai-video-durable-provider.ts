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
 *
 * RC mission Fase 5 ("providerJobId recovery"): además de reutilizar un
 * clip ya COMPLETED, ahora también persiste un registro STARTED con el
 * providerJobId en cuanto el proveedor real lanza un error que YA lo trae
 * (ver GenerativeProviderError.providerJobId, adjuntado por veo.ts para
 * cualquier fallo posterior al envío — timeout de sondeo, fallo de
 * descarga, etc.). Si un intento posterior encuentra ese registro STARTED
 * y el proveedor admite `resumeGeneration()`, reanuda esa MISMA operación
 * en vez de enviar una segunda — nunca hay un segundo submitGeneration
 * para el mismo shot. Límite conocido y documentado (no oculto): si el
 * proceso entero muere sin lanzar ninguna excepción (p. ej. un SIGKILL a
 * mitad del sondeo), no hay nada que capturar para persistir el
 * providerJobId — ese caso sigue exigiendo revisión manual, igual que ya
 * ocurrió una vez en producción durante P2B (ver el comentario de
 * waitForCompletion en veo.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { GenerativeProviderError, type GenerativeAsset, type VideoGenerationRequest, type VideoProvider } from "@/lib/providers/types";
import {
  AI_VIDEO_STORAGE_BUCKET,
  readAiVideoClipRecord,
  resolveAiVideoStorageAsset,
  validateExistingAiVideoClip,
  writeAiVideoClipRecord,
} from "./ai-video-storage";
import type { ResolvedAiVideoClip } from "./ai-video-resolver";

export function wrapDurableVideoProvider(
  inner: VideoProvider,
  opts: { supabase: SupabaseClient; scopeId: string; executionMode?: "simulation" | "real" },
): VideoProvider {
  const executionMode = opts.executionMode ?? "real";

  async function persistCompleted(shotId: string, asset: GenerativeAsset): Promise<void> {
    const clip: ResolvedAiVideoClip = {
      shotId,
      buffer: asset.buffer,
      mimeType: asset.mimeType,
      extension: asset.extension,
      durationSeconds: asset.durationSeconds ?? 0,
      widthPx: asset.width,
      heightPx: asset.height,
      provider: inner.name,
      model: asset.model,
      costUsd: asset.costUsd,
      providerJobId: asset.providerJobId,
      sourceHasGeneratedAudio: asset.sourceHasGeneratedAudio,
    };
    await resolveAiVideoStorageAsset(opts.supabase, clip, { scopeId: opts.scopeId, idempotencyKey: shotId, executionMode });
  }

  /** Solo persiste si el error YA trae un providerJobId (operación real ya creada en el proveedor) — nunca inventa uno. */
  async function persistStartedIfRecoverable(shotId: string, err: unknown): Promise<void> {
    if (!(err instanceof GenerativeProviderError) || !err.providerJobId) return;
    const nowIso = new Date().toISOString();
    const existing = await readAiVideoClipRecord(opts.supabase, AI_VIDEO_STORAGE_BUCKET, opts.scopeId, shotId);
    if (existing?.status === "COMPLETED") return; // nunca degrada un COMPLETED ya válido
    await writeAiVideoClipRecord(opts.supabase, AI_VIDEO_STORAGE_BUCKET, {
      idempotencyKey: shotId,
      scopeId: opts.scopeId,
      shotId,
      status: "STARTED",
      provider: inner.name,
      providerJobId: err.providerJobId,
      executionMode,
      createdAtIso: existing?.createdAtIso ?? nowIso,
      updatedAtIso: nowIso,
    });
  }

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

      if (existing?.status === "STARTED" && existing.providerJobId) {
        if (!inner.resumeGeneration) {
          throw new Error(
            `wrapDurableVideoProvider: el shot "${shotId}" ya tiene una operación STARTED en "${inner.name}" ` +
              `(providerJobId "${existing.providerJobId}") de un intento anterior, pero este proveedor no admite ` +
              `reanudar sondeo (resumeGeneration). Nunca se envía una segunda generación en su lugar — revisa ` +
              `manualmente el estado de esa operación en el proveedor antes de reintentar.`,
          );
        }
        try {
          const asset = await inner.resumeGeneration(existing.providerJobId, request);
          await persistCompleted(shotId, asset);
          return asset;
        } catch (err) {
          await persistStartedIfRecoverable(shotId, err);
          throw err;
        }
      }

      try {
        const asset = await inner.generateVideo(request);
        await persistCompleted(shotId, asset);
        return asset;
      } catch (err) {
        await persistStartedIfRecoverable(shotId, err);
        throw err;
      }
    },
  };
}
