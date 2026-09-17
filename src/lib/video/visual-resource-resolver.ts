import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImageProvider } from "@/lib/providers/image";
import type { StoryboardScene } from "./storyboard/types";
import { generatedImageObjectPrefix } from "./visual-resource-planner";
import { validateVisualAssetBuffer } from "./visual-asset-validation";

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
  sceneIndex,
  scene,
  imageProvider,
  remainingBudgetUsd,
  signedUrlTtlSeconds,
}: {
  supabase: SupabaseClient;
  bucket: string;
  requestId: string;
  sceneIndex: number;
  scene: StoryboardScene;
  imageProvider: ImageProvider;
  remainingBudgetUsd: number;
  signedUrlTtlSeconds: number;
}): Promise<GeneratedImageOutcome> {
  const existing = await findExistingGeneratedImage(supabase, bucket, requestId, sceneIndex);
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

  const asset = await imageProvider.generateImage({
    prompt: scene.imagePrompt,
    negativePrompt: scene.negativePrompt,
    aspectRatio: "9:16",
    maxCostUsd: remainingBudgetUsd,
  });

  // Nunca confiar en que "la llamada no lanzó" ya implica "es un archivo
  // usable" — se valida ANTES de subir nada a Storage.
  const validation = validateVisualAssetBuffer(asset.buffer, asset.mimeType);
  if (!validation.valid) {
    throw new Error(`El proveedor de imagen "${imageProvider.name}" devolvió un archivo inválido: ${validation.reason}`);
  }

  const path = `${requestId}/${generatedImageObjectPrefix(sceneIndex)}.${asset.extension}`;
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(path, asset.buffer, { contentType: asset.mimeType, upsert: true });
  if (uploadError) {
    throw new Error(`No se pudo subir la imagen generada (${path}): ${uploadError.message}`);
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
