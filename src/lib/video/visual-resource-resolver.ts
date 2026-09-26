import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImageProvider } from "@/lib/providers/image";
import type { StoryboardScene } from "./storyboard/types";
import { generatedImageObjectPrefix } from "./visual-resource-planner";
import { validateVisualAssetBuffer } from "./visual-asset-validation";
import { StorageStateUnknownError, readJsonState, uploadWithRetry, writeJsonState } from "./audiovisual/storage-state";
import { NotSentError, type PaidLedger } from "./audiovisual/paid-ledger";
import { IMAGE_RESERVE_USD, classifyImageFailure } from "./audiovisual/paid-costs";

/**
 * Parte con I/O real del planificador visual — separada de
 * visual-resource-planner.ts (puro, sin red) para poder probar la
 * POLÍTICA sin mockear Supabase, y mockear Supabase sin repetir la
 * política. Nunca decide POR SU CUENTA si debe generar — solo ejecuta la
 * decisión que ya tomó decideResourceStrategy().
 *
 * Idempotencia y cobro único (revisión de Work, PR #13):
 *  1. Antes de llamar al proveedor busca si YA existe `scene-{n}-…` para
 *     este requestId (list() por prefijo). Si Storage no responde, se
 *     DETIENE: un error de listado nunca se interpreta como «no existe».
 *  2. Lee el marcador durable `state/generated/<prefijo>.json`. Si un
 *     intento anterior dejó «started» (quizá se cobró), «generated_invalid»
 *     o «generated_unstored» (se cobró y el archivo no quedó guardado), NO
 *     regenera: lanza GeneratedImageUncertainError para revisión manual.
 *  3. Escribe «started» ANTES de pagar (si no puede, no llama).
 *  4. Tras cobrar, sube con reintentos; si aun así falla, marca
 *     «generated_unstored» y detiene — nunca vuelve a pagar sola.
 *  5. Un fallo con costo cero conocido (error HTTP/moderación/no enviado)
 *     marca «released» y permite reintentar.
 * Con `ledger`, cada llamada queda además reservada/liquidada en el
 * registro de gasto durable (audiovisual/paid-ledger.ts).
 *
 * Nunca cae a otro proveedor de pago si este falla — solo relanza el
 * error para que el llamador decida (el flujo anterior usa stock gratis;
 * el dirigido se detiene).
 */

export type GeneratedImageOutcome = {
  status: "reused" | "generated";
  url: string;
  path: string;
  costUsd: number;
  bufferBytes: number;
  provider: string;
  model?: string;
  width?: number;
  height?: number;
};

export type GeneratedImageMarker = {
  status: "started" | "released" | "generated_invalid" | "generated_unstored" | "stored";
  provider: string;
  updatedAtIso: string;
  costUsd?: number;
  note?: string;
  /** Recuperación manual (audiovisual/recovery.ts): estado previo y momento. */
  previousStatus?: GeneratedImageMarker["status"];
  recoveredAtIso?: string;
};

/** Hay una generación anterior cobrada (o quizá cobrada) sin resultado utilizable: no se regenera automáticamente. */
export class GeneratedImageUncertainError extends Error {
  constructor(public readonly objectPrefix: string, public readonly markerStatus: string) {
    super(
      `La imagen «${objectPrefix}» tiene un intento anterior en estado «${markerStatus}» (posiblemente cobrado y sin archivo guardado). ` +
        "No se regenera automáticamente para no pagar dos veces; requiere revisión.",
    );
    this.name = "GeneratedImageUncertainError";
  }
}

export function generatedImageMarkerPath(requestId: string, objectPrefix: string): string {
  return `${requestId}/state/generated/${objectPrefix}.json`;
}

export async function findExistingGeneratedImage(
  supabase: SupabaseClient,
  bucket: string,
  requestId: string,
  sceneIndex: number,
  objectPrefix?: string,
): Promise<{ path: string } | null> {
  const prefix = objectPrefix ?? generatedImageObjectPrefix(sceneIndex);
  let result: { data: { name: string }[] | null; error: { message?: string } | null };
  try {
    result = await supabase.storage.from(bucket).list(requestId, { search: prefix });
  } catch (err) {
    throw new StorageStateUnknownError(`la imagen «${prefix}»`, err instanceof Error ? err.message : String(err));
  }
  if (result.error || !result.data) {
    throw new StorageStateUnknownError(`la imagen «${prefix}»`, result.error?.message ?? "listado vacío");
  }
  const match = result.data.find((f) => f.name.startsWith(prefix) && !f.name.endsWith(".json"));
  return match ? { path: `${requestId}/${match.name}` } : null;
}

export async function resolveGeneratedImageForScene({
  supabase,
  bucket,
  requestId,
  sceneIndex,
  scene,
  imageProvider,
  remainingBudgetUsd,
  signedUrlTtlSeconds,
  objectPrefix,
  ledger,
  attempt,
}: {
  supabase: SupabaseClient;
  bucket: string;
  requestId: string;
  sceneIndex: number;
  scene: Pick<StoryboardScene, "imagePrompt" | "negativePrompt">;
  imageProvider: ImageProvider;
  remainingBudgetUsd: number;
  signedUrlTtlSeconds: number;
  /**
   * Prefijo propio en Storage (dirección audiovisual: incluye un hash del
   * prompt, así un cambio de guion/estilo nunca reutiliza una imagen
   * anterior). Ausente = `scene-{n}-generated`, como siempre.
   */
  objectPrefix?: string;
  /** Registro de gasto durable (flujo dirigido). Ausente = solo marcadores. */
  ledger?: PaidLedger;
  attempt?: number;
}): Promise<GeneratedImageOutcome> {
  const prefix = objectPrefix ?? generatedImageObjectPrefix(sceneIndex);
  const sign = async (path: string) => {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, signedUrlTtlSeconds);
    if (error || !data) throw new Error(`No se pudo firmar la URL de la imagen generada (${path}): ${error?.message ?? "desconocido"}`);
    return data.signedUrl;
  };

  const existing = await findExistingGeneratedImage(supabase, bucket, requestId, sceneIndex, prefix);
  if (existing) {
    return { status: "reused", url: await sign(existing.path), path: existing.path, costUsd: 0, bufferBytes: 0, provider: imageProvider.name };
  }

  const markerPath = generatedImageMarkerPath(requestId, prefix);
  const marker = await readJsonState<GeneratedImageMarker>(supabase, bucket, markerPath, `el marcador de «${prefix}»`);
  if (marker.kind === "found" && marker.data.status !== "released") {
    throw new GeneratedImageUncertainError(prefix, marker.data.status);
  }
  const mark = (status: GeneratedImageMarker["status"], extra: Partial<GeneratedImageMarker> = {}) =>
    writeJsonState(supabase, bucket, markerPath, { status, provider: imageProvider.name, updatedAtIso: new Date().toISOString(), ...extra } satisfies GeneratedImageMarker);

  const callProvider = async () => {
    try {
      await mark("started");
    } catch (err) {
      throw new NotSentError(`No se pudo guardar el marcador previo de «${prefix}»: ${err instanceof Error ? err.message : err}`);
    }
    return imageProvider.generateImage({ prompt: scene.imagePrompt, negativePrompt: scene.negativePrompt, aspectRatio: "9:16", maxCostUsd: remainingBudgetUsd });
  };

  let asset: Awaited<ReturnType<ImageProvider["generateImage"]>>;
  try {
    asset = ledger
      ? await ledger.run(
          { key: `image:${requestId}/${prefix}`, kind: "image", provider: imageProvider.name, reserveUsd: IMAGE_RESERVE_USD, label: `imagen escena ${sceneIndex + 1}`, units: { images: 1 } },
          async () => {
            const value = await callProvider();
            return { value, settle: { actualUsd: value.costUsd, costBasis: value.costBasis ?? "estimated" } };
          },
          classifyImageFailure,
          attempt,
        )
      : await callProvider();
  } catch (err) {
    if (err instanceof NotSentError || classifyImageFailure(err) === "not_sent") {
      // Costo cero conocido: se libera el marcador (si ya se había escrito) para permitir reintentar.
      await mark("released", { note: err instanceof Error ? err.message.slice(0, 200) : undefined }).catch(() => {});
    }
    // Si no: el marcador queda en «started» → el próximo intento se detiene en vez de volver a pagar.
    throw err;
  }

  // Nunca confiar en que "la llamada no lanzó" ya implica "es un archivo usable" — se valida ANTES de subir nada a Storage.
  const validation = validateVisualAssetBuffer(asset.buffer, asset.mimeType);
  if (!validation.valid) {
    await mark("generated_invalid", { costUsd: asset.costUsd, note: validation.reason }).catch(() => {});
    await ledger?.markResultLost(`image:${requestId}/${prefix}`, `archivo inválido: ${validation.reason}`).catch(() => {});
    throw new Error(`El proveedor de imagen "${imageProvider.name}" devolvió un archivo inválido: ${validation.reason}`);
  }

  const path = `${requestId}/${prefix}.${asset.extension}`;
  try {
    await uploadWithRetry(supabase, bucket, path, asset.buffer, asset.mimeType);
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    await mark("generated_unstored", { costUsd: asset.costUsd, note }).catch(() => {});
    await ledger?.markResultLost(`image:${requestId}/${prefix}`, `cobrada y no guardada: ${note}`).catch(() => {});
    throw new Error(`La imagen generada (cobrada) no se pudo guardar (${path}): ${note}. No se regenerará automáticamente.`);
  }
  await mark("stored", { costUsd: asset.costUsd }).catch((err) => {
    // El archivo ya existe: el próximo intento lo encuentra por listado aunque el marcador quede en «started».
    console.warn(`[atomivid:visual] no se pudo actualizar el marcador de ${prefix}:`, err instanceof Error ? err.message : err);
  });

  return {
    status: "generated",
    url: await sign(path),
    path,
    costUsd: asset.costUsd,
    bufferBytes: asset.buffer.byteLength,
    provider: imageProvider.name,
    model: asset.model,
    width: asset.width,
    height: asset.height,
  };
}
