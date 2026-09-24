/**
 * Galería de REVISIÓN (solo lectura) de las 3 imágenes del Visual Test
 * V2 — lee EXCLUSIVAMENTE los registros `COMPLETED` ya existentes en
 * Supabase Storage (escritos por visual-test-v2-real.ts en un checkpoint
 * anterior) y firma URLs de corta duración para mostrarlas. NO genera,
 * NO regenera, NO llama a ningún proveedor de imagen — este módulo ni
 * siquiera importa `openaiImageProvider`. Reutiliza sin cambios:
 * buildVisualTestV2Manifest() (para los idempotencyKey),
 * readVisualTestV2ShotRecord() (para los registros ya persistidos), y el
 * mismo bucket privado "videos" (createSignedUrl, mismo mecanismo que ya
 * usa visual-resource-resolver.ts — el bucket sigue siendo privado, no
 * se cambia ninguna policy).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildVisualTestV2Manifest } from "./visual-test-v2";
import { VISUAL_TEST_V2_REAL_SHOT_IDS } from "./visual-test-v2-real";
import { readVisualTestV2ShotRecord, VISUAL_TEST_V2_STORAGE_BUCKET } from "./visual-test-v2-storage";

/** Corta duración a propósito — esto es para que una persona vea la imagen en una carga de página, no para uso prolongado ni para embeber en otro sitio. */
export const VISUAL_TEST_V2_GALLERY_SIGNED_URL_TTL_SECONDS = 300;

export type VisualTestV2GalleryItem = {
  shotId: string;
  status: "COMPLETED";
  signedUrl: string;
  storagePath: string;
  costUsd: number;
  widthPx?: number;
  heightPx?: number;
  provider?: string;
  model?: string;
  quality?: string;
};

/**
 * Devuelve, en el orden fijo de VISUAL_TEST_V2_REAL_SHOT_IDS, solo los
 * shots con un registro `COMPLETED` válido (con storagePath) cuya URL se
 * pudo firmar. Un shot sin registro, con registro `STARTED`, o cuya
 * firma falla, simplemente se omite — nunca lanza, nunca dispara ninguna
 * generación.
 */
export async function buildVisualTestV2Gallery(
  supabase: SupabaseClient,
  bucket: string = VISUAL_TEST_V2_STORAGE_BUCKET,
  signedUrlTtlSeconds: number = VISUAL_TEST_V2_GALLERY_SIGNED_URL_TTL_SECONDS,
): Promise<VisualTestV2GalleryItem[]> {
  const manifest = buildVisualTestV2Manifest();
  const videoId = manifest.videoId;

  const items: VisualTestV2GalleryItem[] = [];
  for (const shotId of VISUAL_TEST_V2_REAL_SHOT_IDS) {
    const entry = manifest.shots.find((s) => s.shotId === shotId);
    if (!entry) continue;

    const record = await readVisualTestV2ShotRecord(supabase, bucket, videoId, entry.idempotencyKey);
    if (!record || record.status !== "COMPLETED" || !record.storagePath) continue;

    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(record.storagePath, signedUrlTtlSeconds);
    if (error || !data) continue;

    items.push({
      shotId,
      status: "COMPLETED",
      signedUrl: data.signedUrl,
      storagePath: record.storagePath,
      costUsd: record.costUsd ?? 0,
      widthPx: record.widthPx,
      heightPx: record.heightPx,
      provider: record.provider,
      model: record.model,
      quality: record.quality,
    });
  }
  return items;
}
