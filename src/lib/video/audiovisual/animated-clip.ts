/**
 * Clip de «Animación IA» para UNA escena del Reel: image-to-video con
 * gasto controlado y recuperable. Mismo diseño que las imágenes
 * (visual-resource-resolver.ts) más la reanudación de operaciones largas:
 *
 *  1. Clip ya guardado → se reutiliza (costo 0).
 *  2. Marcador de la escena (`state/animation/<prefijo>.json`):
 *     - submitted + operationName → se REANUDA el sondeo de esa operación
 *       (VideoProvider.resumeGeneration): nunca se envía otra, y se liquida
 *       la MISMA reserva del registro.
 *     - started (reservado, sin id de operación), generated_unstored,
 *       generated_invalid, failed_operation → incierto: se detiene y pide
 *       recuperación explícita (recovery.ts). Nunca se repite solo.
 *     - released o ausente → generación nueva.
 *  3. Generación nueva: reserva persistida ANTES de llamar (registro
 *     durable), marcador «started», envío con la ilustración de la escena
 *     como imagen de entrada real, y en cuanto el proveedor acepta la
 *     operación se guarda su id («submitted»).
 *  4. Validación del archivo, subida con reintentos y marcador «stored».
 *
 * Un fallo NUNCA se sustituye por una imagen fija con zoom: se propaga con
 * un motivo claro y el estado queda recuperable.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { GenerativeProviderError, type GenerativeAsset, type VideoGenerationRequest, type VideoProvider } from "@/lib/providers/types";
import { NotSentError, type FailureClass, type PaidLedger, type SettleOutcome } from "./paid-ledger";
import { StorageStateUnknownError, readJsonState, uploadWithRetry, writeJsonState } from "./storage-state";
import { REEL_ANIMATION, animatedClipObjectPrefix, animationClipCostUsd, type SceneAnimationSpec } from "./animation";

export type AnimationMarker = {
  status: "started" | "submitted" | "released" | "generated_invalid" | "generated_unstored" | "stored" | "failed_operation";
  provider: string;
  model: string;
  /** Id de la operación del proveedor (Veo: "models/…/operations/…"), en cuanto fue aceptada. */
  operationName?: string;
  /** Huella de la ilustración de entrada (sha256 de los bytes enviados). */
  inputImageSha256?: string;
  updatedAtIso: string;
  costUsd?: number;
  note?: string;
  previousStatus?: AnimationMarker["status"];
  recoveredAtIso?: string;
};

export class AnimatedClipUncertainError extends Error {
  constructor(public readonly objectPrefix: string, public readonly markerStatus: string, detail: string) {
    super(
      `La animación «${objectPrefix}» tiene un intento anterior en estado «${markerStatus}» (${detail}). ` +
        "No se vuelve a generar automáticamente para no pagar dos veces; requiere revisión y recuperación explícita.",
    );
    this.name = "AnimatedClipUncertainError";
  }
}

export class AnimationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnimationFailedError";
  }
}

export function animationMarkerPath(requestId: string, objectPrefix: string): string {
  return `${requestId}/state/animation/${objectPrefix}.json`;
}

export function animationLedgerKey(requestId: string, objectPrefix: string): string {
  return `video:${requestId}/${objectPrefix}`;
}

/**
 * Costo cero solo con evidencia (providers/charge-outcome.ts): el adaptador
 * declara `chargeOutcome`; sin declaración, solo los motivos que por
 * construcción ocurren antes de llamar. Una operación ya aceptada (tiene
 * id) nunca es costo cero.
 */
export function classifyAnimationFailure(err: unknown): FailureClass {
  if (err instanceof GenerativeProviderError) {
    if (err.providerJobId) return "uncertain";
    if (err.chargeOutcome) return err.chargeOutcome === "uncertain" ? "uncertain" : "not_sent";
    return err.reason === "not_configured" || err.reason === "budget_exceeded" ? "not_sent" : "uncertain";
  }
  return "uncertain";
}

/** Motivos con operación ya creada que sí pueden reanudarse (el sondeo o la descarga se cortaron). */
const RESUMABLE_REASONS = new Set<GenerativeProviderError["reason"]>(["timeout", "upstream_error", "download_failed", "rate_limited"]);

async function findExistingClip(supabase: SupabaseClient, bucket: string, requestId: string, prefix: string): Promise<string | null> {
  let result: { data: { name: string }[] | null; error: { message?: string } | null };
  try {
    result = await supabase.storage.from(bucket).list(requestId, { search: prefix });
  } catch (err) {
    throw new StorageStateUnknownError(`la animación «${prefix}»`, err instanceof Error ? err.message : String(err));
  }
  if (result.error || !result.data) throw new StorageStateUnknownError(`la animación «${prefix}»`, result.error?.message ?? "listado vacío");
  const match = result.data.find((f) => f.name.startsWith(prefix) && f.name.endsWith(".mp4"));
  return match ? `${requestId}/${match.name}` : null;
}

/** Un MP4 válido lleva la caja «ftyp» en los bytes 4–8. */
export function looksLikeMp4(buffer: Buffer): boolean {
  return buffer.byteLength > 12 && buffer.toString("ascii", 4, 8) === "ftyp";
}

/**
 * Imagen de entrada del clip: la ilustración base de la escena recortada a
 * 9:16 (1080×1920, centro) para que coincida con el formato pedido a Veo.
 * Gratis y determinista: se guarda una vez y se reutiliza.
 */
export async function prepareAnimationInputImage(input: {
  supabase: SupabaseClient;
  bucket: string;
  requestId: string;
  baseImagePath: string;
  objectPrefix: string;
  signedUrlTtlSeconds: number;
}): Promise<{ path: string; url: string; sha256: string }> {
  const path = `${input.requestId}/anim-input/${input.objectPrefix}.png`;
  const storage = input.supabase.storage.from(input.bucket);
  const existing = await storage.download(path);
  let png: Buffer;
  if (existing.data && !existing.error) {
    png = Buffer.from(await existing.data.arrayBuffer());
  } else {
    const base = await storage.download(input.baseImagePath);
    if (base.error || !base.data) throw new StorageStateUnknownError("la ilustración base de la escena", base.error?.message ?? "vacía");
    png = await sharp(Buffer.from(await base.data.arrayBuffer())).resize(1080, 1920, { fit: "cover", position: "centre" }).png().toBuffer();
    await uploadWithRetry(input.supabase, input.bucket, path, png, "image/png");
  }
  const { data, error } = await storage.createSignedUrl(path, input.signedUrlTtlSeconds);
  if (error || !data) throw new Error(`No se pudo firmar la imagen de entrada de la animación: ${error?.message ?? "desconocido"}`);
  return { path, url: data.signedUrl, sha256: createHash("sha256").update(png).digest("hex") };
}

export type AnimatedClipOutcome = {
  status: "generated" | "reused" | "resumed";
  path: string;
  url: string;
  costUsd: number;
  operationName?: string;
  bufferBytes: number;
};

export async function resolveAnimatedClipForScene({
  supabase,
  bucket,
  requestId,
  spec,
  inputImage,
  videoProvider,
  maxCostUsd,
  signedUrlTtlSeconds,
  ledger,
  attempt,
}: {
  supabase: SupabaseClient;
  bucket: string;
  requestId: string;
  spec: SceneAnimationSpec;
  /** Imagen de entrada real (URL firmada que el adaptador descarga y envía como bytes). */
  inputImage: { url: string; sha256: string };
  videoProvider: VideoProvider;
  maxCostUsd: number;
  signedUrlTtlSeconds: number;
  ledger?: PaidLedger;
  attempt?: number;
}): Promise<AnimatedClipOutcome> {
  const prefix = animatedClipObjectPrefix(spec.sceneIndex, spec.key);
  const markerPath = animationMarkerPath(requestId, prefix);
  const ledgerKey = animationLedgerKey(requestId, prefix);
  const sign = async (path: string) => {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, signedUrlTtlSeconds);
    if (error || !data) throw new Error(`No se pudo firmar el clip animado (${path}): ${error?.message ?? "desconocido"}`);
    return data.signedUrl;
  };

  const existing = await findExistingClip(supabase, bucket, requestId, prefix);
  if (existing) return { status: "reused", path: existing, url: await sign(existing), costUsd: 0, bufferBytes: 0 };

  const marker = await readJsonState<AnimationMarker>(supabase, bucket, markerPath, `el marcador de «${prefix}»`);
  const mark = (status: AnimationMarker["status"], extra: Partial<AnimationMarker> = {}) =>
    writeJsonState(supabase, bucket, markerPath, {
      status,
      provider: videoProvider.name,
      model: REEL_ANIMATION.model,
      inputImageSha256: inputImage.sha256,
      updatedAtIso: new Date().toISOString(),
      ...(marker.kind === "found" && marker.data.operationName ? { operationName: marker.data.operationName } : {}),
      ...extra,
    } satisfies AnimationMarker);

  const request: VideoGenerationRequest = {
    prompt: spec.prompt,
    negativePrompt: spec.negativePrompt,
    aspectRatio: REEL_ANIMATION.aspectRatio,
    durationSeconds: REEL_ANIMATION.clipSeconds,
    maxCostUsd,
    referenceImageUrl: inputImage.url,
    metadata: { requestId, scene: String(spec.sceneIndex), clipKey: spec.key },
  };
  const settleOf = (asset: GenerativeAsset): SettleOutcome => ({
    actualUsd: asset.costUsd,
    costBasis: "estimated",
    note: `${asset.durationSeconds ?? REEL_ANIMATION.clipSeconds}s facturables × tarifa registrada; operación ${asset.providerJobId ?? "sin id"}`,
  });

  let asset: GenerativeAsset;
  let resumed = false;
  if (marker.kind === "found" && marker.data.status === "submitted" && marker.data.operationName) {
    // Reanudación: la operación ya existe (y ya cuenta desde su reserva).
    const operationName = marker.data.operationName;
    if (!videoProvider.resumeGeneration) {
      throw new AnimatedClipUncertainError(prefix, "submitted", `el proveedor «${videoProvider.name}» no admite reanudar la operación ${operationName}`);
    }
    const resume = () => videoProvider.resumeGeneration!(operationName, request);
    try {
      asset = ledger ? await ledger.resumeReserved(ledgerKey, async () => {
        const value = await resume();
        return { value, settle: settleOf(value) };
      }) : await resume();
    } catch (err) {
      await onFailureWithOperation(err, operationName);
      throw err;
    }
    resumed = true;
  } else {
    if (marker.kind === "found" && marker.data.status !== "released") {
      throw new AnimatedClipUncertainError(prefix, marker.data.status, marker.data.note ?? "pudo cobrarse sin resultado guardado");
    }
    let acceptedOperation: string | undefined;
    const call = async () => {
      try {
        await mark("started");
      } catch (err) {
        throw new NotSentError(`No se pudo guardar el marcador previo de «${prefix}»: ${err instanceof Error ? err.message : err}`);
      }
      return videoProvider.generateVideo({
        ...request,
        onProviderJobAccepted: async (operationName) => {
          acceptedOperation = operationName;
          await mark("submitted", { operationName });
        },
      });
    };
    try {
      asset = ledger
        ? await ledger.run(
            {
              key: ledgerKey,
              kind: "video",
              provider: videoProvider.name,
              reserveUsd: animationClipCostUsd(),
              label: `animación escena ${spec.sceneIndex + 1}`,
              units: { videoSeconds: request.durationSeconds },
            },
            async () => {
              const value = await call();
              return { value, settle: settleOf(value) };
            },
            classifyAnimationFailure,
            attempt,
          )
        : await call();
    } catch (err) {
      const operationName = err instanceof GenerativeProviderError ? (err.providerJobId ?? acceptedOperation) : acceptedOperation;
      if (operationName) {
        await onFailureWithOperation(err, operationName);
      } else if (err instanceof NotSentError || classifyAnimationFailure(err) === "not_sent") {
        await mark("released", { note: err instanceof Error ? err.message.slice(0, 200) : undefined }).catch(() => {});
      }
      // Si no: el marcador queda «started» → el próximo intento se detiene (cobro incierto).
      throw err;
    }
  }

  const operationName = asset.providerJobId;
  if (!looksLikeMp4(asset.buffer)) {
    const note = `archivo recibido no es un MP4 válido (${asset.buffer.byteLength} bytes)`;
    await mark("generated_invalid", { costUsd: asset.costUsd, note, ...(operationName ? { operationName } : {}) }).catch(() => {});
    await ledger?.markResultLost(ledgerKey, note).catch(() => {});
    throw new AnimationFailedError(`La animación de la escena ${spec.sceneIndex + 1} devolvió un archivo inválido: ${note}.`);
  }
  const path = `${requestId}/${prefix}.mp4`;
  try {
    await uploadWithRetry(supabase, bucket, path, asset.buffer, "video/mp4");
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    await mark("generated_unstored", { costUsd: asset.costUsd, note, ...(operationName ? { operationName } : {}) }).catch(() => {});
    await ledger?.markResultLost(ledgerKey, `cobrada y no guardada: ${note}`).catch(() => {});
    throw new AnimationFailedError(`La animación de la escena ${spec.sceneIndex + 1} (cobrada) no se pudo guardar: ${note}. No se regenerará automáticamente.`);
  }
  await mark("stored", { costUsd: asset.costUsd, ...(operationName ? { operationName } : {}) }).catch((err) => {
    console.warn(`[atomivid:animation] no se pudo actualizar el marcador de ${prefix}:`, err instanceof Error ? err.message : err);
  });
  return {
    status: resumed ? "resumed" : "generated",
    path,
    url: await sign(path),
    costUsd: asset.costUsd,
    ...(operationName ? { operationName } : {}),
    bufferBytes: asset.buffer.byteLength,
  };

  /** Operación ya creada: si el corte fue del sondeo/descarga, queda reanudable; si la operación falló, se bloquea para revisión. */
  async function onFailureWithOperation(err: unknown, operationName: string): Promise<void> {
    const resumable = err instanceof GenerativeProviderError && RESUMABLE_REASONS.has(err.reason);
    const note = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    await mark(resumable ? "submitted" : "failed_operation", { operationName, note }).catch(() => {});
   }
}
