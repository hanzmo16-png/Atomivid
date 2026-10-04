import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImageProvider } from "@/lib/providers/image";
import type { StoryboardScene } from "./storyboard/types";
import { generatedImageObjectPrefix } from "./visual-resource-planner";
import { validateVisualAssetBuffer } from "./visual-asset-validation";
import { guardPaidCall, type LedgerStore } from "@/lib/paid-calls/gate";

/**
 * Parte con I/O real del planificador visual — separada de
 * visual-resource-planner.ts (puro, sin red) para poder probar la
 * POLÍTICA sin mockear Supabase, y mockear Supabase sin repetir la
 * política. Nunca decide POR SU CUENTA si debe generar — solo ejecuta la
 * decisión que ya tomó decideResourceStrategy().
 *
 * Idempotencia: antes de llamar al proveedor, busca si YA existe un
 * archivo `scene-{n}-generated.*` para este requestId (list() por
 * prefijo, sin asumir la extensión — OpenAI real devuelve .png, el
 * fixture .svg). Si existe, lo reutiliza (costo $0, cero llamadas) — así
 * un reintento del mismo job después de un fallo POSTERIOR (p. ej. falla
 * el render, no la generación) nunca vuelve a facturar la misma escena.
 *
 * Nunca cae a otro proveedor de pago si este falla — solo relanza el
 * error para que el llamador (generate-video.ts) use stock (gratis) como
 * único fallback, nunca otro proveedor pagado en silencio.
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

export async function findExistingGeneratedImage(
  supabase: SupabaseClient,
  bucket: string,
  requestId: string,
  sceneIndex: number,
): Promise<{ path: string } | null> {
  const prefix = generatedImageObjectPrefix(sceneIndex);
  const { data, error } = await supabase.storage.from(bucket).list(requestId, { search: prefix });
  if (error || !data) return null;
  const match = data.find((f) => f.name.startsWith(prefix));
  return match ? { path: `${requestId}/${match.name}` } : null;
}

export async function resolveGeneratedImageForScene({
  supabase,
  bucket,
  requestId,
  artifactPrefix = requestId,
  disableProviderRetries = false,
  sceneIndex,
  scene,
  imageProvider,
  remainingBudgetUsd,
  signedUrlTtlSeconds,
  ledger,
}: {
  supabase: SupabaseClient;
  bucket: string;
  requestId: string;
  artifactPrefix?: string;
  disableProviderRetries?: boolean;
  sceneIndex: number;
  scene: StoryboardScene;
  imageProvider: ImageProvider;
  remainingBudgetUsd: number;
  signedUrlTtlSeconds: number;
  /**
   * Puerta de llamadas pagadas (PI V2 B1, RB-01). Obligatoria para un proveedor real: la fila
   * de `pi_paid_operations` se escribe antes del HTTP; COMMITTED sin objeto en Storage no
   * vuelve a generar. El fixture (sin red, sin costo) no pasa por ella.
   */
  ledger?: LedgerStore;
}): Promise<GeneratedImageOutcome> {
  const existing = await findExistingGeneratedImage(supabase, bucket, artifactPrefix, sceneIndex);
  if (existing) {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(existing.path, signedUrlTtlSeconds);
    if (error || !data) {
      throw new Error(`No se pudo firmar la URL del recurso generado reutilizado (${existing.path}): ${error?.message ?? "desconocido"}`);
    }
    return {
      status: "reused",
      url: data.signedUrl,
      path: existing.path,
      costUsd: 0,
      bufferBytes: 0,
      provider: imageProvider.name,
    };
  }

  const request = {
    disableRetries: disableProviderRetries,
    prompt: scene.imagePrompt,
    negativePrompt: scene.negativePrompt,
    aspectRatio: "9:16" as const,
    maxCostUsd: remainingBudgetUsd,
  };
  const generateAndStore = async () => {
    const asset = await imageProvider.generateImage(request);

    // Nunca confiar en que "la llamada no lanzó" ya implica "es un archivo
    // usable" — se valida ANTES de subir nada a Storage.
    const validation = validateVisualAssetBuffer(asset.buffer, asset.mimeType);
    if (!validation.valid) {
      throw new Error(`El proveedor de imagen "${imageProvider.name}" devolvió un archivo inválido: ${validation.reason}`);
    }

    const path = `${artifactPrefix}/${generatedImageObjectPrefix(sceneIndex)}.${asset.extension}`;
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(path, asset.buffer, { contentType: asset.mimeType, upsert: true });
    if (uploadError) {
      throw new Error(`No se pudo subir la imagen generada (${path}): ${uploadError.message}`);
    }
    return { asset, path };
  };

  let asset: Awaited<ReturnType<typeof generateAndStore>>["asset"];
  let path: string;
  if (imageProvider.name === "fixture" || !ledger) {
    if (imageProvider.name !== "fixture") {
      throw new Error(`Imagen generada para la escena ${sceneIndex}: proveedor real "${imageProvider.name}" sin puerta de llamadas pagadas — no se llama.`);
    }
    ({ asset, path } = await generateAndStore());
  } else {
    const guarded = await guardPaidCall<{ asset: Awaited<ReturnType<typeof generateAndStore>>["asset"]; path: string }>(
      ledger,
      {
        projectId: requestId,
        shotId: `image:scene-${sceneIndex}`,
        provider: imageProvider.name,
        model: imageProvider.name,
        method: "generate_image",
        inputFingerprint: { prompt: request.prompt, negativePrompt: request.negativePrompt ?? null, aspectRatio: request.aspectRatio },
        reservedUsd: Math.max(0, remainingBudgetUsd),
      },
      {
        call: async () => {
          const r = await generateAndStore();
          return { result: r, costUsd: r.asset.costUsd, resultRef: r.path };
        },
        // `findExistingGeneratedImage` ya se consultó arriba: llegar aquí con COMMITTED significa
        // que el objeto pagado no está en Storage. No se genera de nuevo.
        load: async () => null,
        // El proveedor de imagen ya reintenta UNA vez por su cuenta ante un rechazo explícito
        // (openai.ts MAX_RETRIES); la puerta no añade otro para no superar un reintento.
        maxRejectedRetries: 0,
      },
    );
    ({ asset, path } = guarded.result);
  }

  const { data, error: signError } = await supabase.storage.from(bucket).createSignedUrl(path, signedUrlTtlSeconds);
  if (signError || !data) {
    throw new Error(`No se pudo firmar la URL de la imagen generada (${path}): ${signError?.message ?? "desconocido"}`);
  }

  return {
    status: "generated",
    url: data.signedUrl,
    path,
    costUsd: asset.costUsd,
    bufferBytes: asset.buffer.byteLength,
    provider: imageProvider.name,
    model: asset.model,
    width: asset.width,
    height: asset.height,
  };
}
