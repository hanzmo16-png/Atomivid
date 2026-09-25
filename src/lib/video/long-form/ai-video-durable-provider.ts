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

/** Fallos con los que reanudar la MISMA operación tiene sentido (el proveedor sigue teniendo el trabajo pagado). */
const RESUMABLE_REASONS = new Set<GenerativeProviderError["reason"]>(["timeout", "upstream_error", "download_failed", "rate_limited"]);
/** Fallos terminales de la operación: reanudar/reenviar nunca va a cambiar el resultado. */
const TERMINAL_REASONS = new Set<GenerativeProviderError["reason"]>(["moderation_rejected", "invalid_request", "invalid_response"]);

export type DurableVideoProviderOptions = {
  supabase: SupabaseClient;
  scopeId: string;
  executionMode?: "simulation" | "real";
  /**
   * Reserva (write-ahead) del presupuesto confirmado ANTES de un envío
   * NUEVO — nunca se llama para reutilizar un COMPLETED ni para reanudar un
   * STARTED. `false` → no se envía (budget_exceeded), el llamador cae al
   * fallback.
   */
  beforeSubmit?: (request: VideoGenerationRequest) => Promise<boolean>;
  /** Reanudaciones de la MISMA operación dentro de este intento ante un fallo transitorio con providerJobId. Default 0 (comportamiento histórico). */
  maxInAttemptResumes?: number;
  resumeBackoffMs?: number;
};

export function wrapDurableVideoProvider(inner: VideoProvider, opts: DurableVideoProviderOptions): VideoProvider {
  const executionMode = opts.executionMode ?? "real";
  const maxInAttemptResumes = opts.maxInAttemptResumes ?? 0;
  const resumeBackoffMs = opts.resumeBackoffMs ?? 5000;

  async function persistStartedWithJobId(shotId: string, providerJobId: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const existing = await readAiVideoClipRecord(opts.supabase, AI_VIDEO_STORAGE_BUCKET, opts.scopeId, shotId);
    if (existing?.status === "COMPLETED") return;
    await writeAiVideoClipRecord(opts.supabase, AI_VIDEO_STORAGE_BUCKET, {
      idempotencyKey: shotId,
      scopeId: opts.scopeId,
      shotId,
      status: "STARTED",
      provider: inner.name,
      providerJobId,
      executionMode,
      createdAtIso: existing?.createdAtIso ?? nowIso,
      updatedAtIso: nowIso,
    });
  }

  async function persistTerminalFailure(shotId: string, err: GenerativeProviderError): Promise<void> {
    const nowIso = new Date().toISOString();
    const existing = await readAiVideoClipRecord(opts.supabase, AI_VIDEO_STORAGE_BUCKET, opts.scopeId, shotId);
    if (existing?.status === "COMPLETED") return;
    await writeAiVideoClipRecord(opts.supabase, AI_VIDEO_STORAGE_BUCKET, {
      idempotencyKey: shotId,
      scopeId: opts.scopeId,
      shotId,
      status: "FAILED",
      provider: inner.name,
      providerJobId: err.providerJobId ?? existing?.providerJobId,
      executionMode,
      createdAtIso: existing?.createdAtIso ?? nowIso,
      updatedAtIso: nowIso,
    });
  }

  /**
   * Reanuda la misma operación ante fallos transitorios (acotado); marca
   * FAILED ante un fallo terminal. Nunca reenvía.
   */
  async function resumeWithRetries(shotId: string, providerJobId: string, request: VideoGenerationRequest, attemptsLeft: number): Promise<GenerativeAsset> {
    if (!inner.resumeGeneration) {
      throw new Error(
        `wrapDurableVideoProvider: el shot "${shotId}" ya tiene una operación STARTED en "${inner.name}" ` +
          `(providerJobId "${providerJobId}") de un intento anterior, pero este proveedor no admite ` +
          `reanudar sondeo (resumeGeneration). Nunca se envía una segunda generación en su lugar — revisa ` +
          `manualmente el estado de esa operación en el proveedor antes de reintentar.`,
      );
    }
    try {
      return await inner.resumeGeneration(providerJobId, request);
    } catch (err) {
      if (err instanceof GenerativeProviderError && TERMINAL_REASONS.has(err.reason)) {
        await persistTerminalFailure(shotId, err);
        throw err;
      }
      if (attemptsLeft > 0 && err instanceof GenerativeProviderError && RESUMABLE_REASONS.has(err.reason)) {
        if (resumeBackoffMs > 0) await new Promise((r) => setTimeout(r, resumeBackoffMs));
        return resumeWithRetries(shotId, providerJobId, request, attemptsLeft - 1);
      }
      await persistStartedIfRecoverable(shotId, err);
      throw err;
    }
  }

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
      if (!shotId) {
        // Sin clave de idempotencia no hay reuso posible, pero el presupuesto
        // confirmado se respeta igual: nunca un envío sin reserva.
        if (opts.beforeSubmit && !(await opts.beforeSubmit(request))) {
          throw new GenerativeProviderError("El presupuesto confirmado de video IA no permite otro envío.", inner.name, "budget_exceeded");
        }
        return inner.generateVideo(request);
      }

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

      if (existing?.status === "FAILED") {
        throw new GenerativeProviderError(
          `El shot "${shotId}" ya tuvo un fallo terminal en "${inner.name}" — no se reenvía; se usa el fallback.`,
          inner.name,
          "invalid_request",
          undefined,
          existing.providerJobId,
        );
      }

      if (existing?.status === "STARTED" && existing.providerJobId) {
        const asset = await resumeWithRetries(shotId, existing.providerJobId, request, maxInAttemptResumes);
        await persistCompletedTolerant(shotId, asset);
        return asset;
      }

      if (opts.beforeSubmit && !(await opts.beforeSubmit(request))) {
        throw new GenerativeProviderError(
          `El presupuesto confirmado de video IA no permite otro envío para el shot "${shotId}".`,
          inner.name,
          "budget_exceeded",
        );
      }

      let acceptedJobId: string | undefined;
      const submitted: VideoGenerationRequest = {
        ...request,
        onProviderJobAccepted: async (providerJobId) => {
          acceptedJobId = providerJobId;
          await persistStartedWithJobId(shotId, providerJobId);
          await request.onProviderJobAccepted?.(providerJobId);
        },
      };
      try {
        const asset = await inner.generateVideo(submitted);
        await persistCompletedTolerant(shotId, asset);
        return asset;
      } catch (err) {
        const jobId = (err instanceof GenerativeProviderError && err.providerJobId) || acceptedJobId;
        if (err instanceof GenerativeProviderError && TERMINAL_REASONS.has(err.reason) && jobId) {
          await persistTerminalFailure(shotId, new GenerativeProviderError(err.message, err.providerId, err.reason, err.cause, jobId));
          throw err;
        }
        if (jobId && maxInAttemptResumes > 0 && err instanceof GenerativeProviderError && RESUMABLE_REASONS.has(err.reason)) {
          if (resumeBackoffMs > 0) await new Promise((r) => setTimeout(r, resumeBackoffMs));
          const asset = await resumeWithRetries(shotId, jobId, request, maxInAttemptResumes - 1);
          await persistCompletedTolerant(shotId, asset);
          return asset;
        }
        await persistStartedIfRecoverable(shotId, err);
        throw err;
      }
    },
  };

  /**
   * Un fallo al PERSISTIR un clip ya generado nunca se convierte en otro
   * envío: el STARTED ya guarda el providerJobId, así que el siguiente
   * intento reanuda/descarga esa misma operación. En este intento se usa
   * el buffer que ya tenemos en memoria.
   */
  async function persistCompletedTolerant(shotId: string, asset: GenerativeAsset): Promise<void> {
    try {
      await persistCompleted(shotId, asset);
    } catch (err) {
      console.warn(
        `[atomivid:ai-video-durable] no se pudo persistir el clip COMPLETED de "${shotId}" — se usa el buffer en memoria; un reintento reanudará la operación ${asset.providerJobId ?? "(sin id)"} sin reenviar:`,
        err instanceof Error ? err.message : err,
      );
      if (asset.providerJobId) {
        await persistStartedWithJobId(shotId, asset.providerJobId).catch(() => {});
      }
    }
  }
}
