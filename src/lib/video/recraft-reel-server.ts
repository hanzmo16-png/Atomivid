import type { SupabaseClient } from "@supabase/supabase-js";
import type { GeneratedScript } from "@/lib/providers/types";
import { parseStoredRecraftStyle, recraftReelEstimateUsd, RECRAFT_MAX_REFERENCE_BYTES, RECRAFT_MAX_REFERENCES, RECRAFT_REFERENCE_TYPES, type ReelRecraftStyle } from "./recraft-reel";
import { imageDimensions } from "@/lib/providers/image/recraft";

const BUCKET = "videos";
export type ReelRecraftRow = { style: ReelRecraftStyle; styleId: string | null };

/**
 * Reads the Reel's Recraft choice in its OWN query, so the worker and the render route keep working unchanged when
 * the additive migration is not applied yet (column absent ⇒ nobody could choose Recraft ⇒ null). Any other read
 * error fails closed (throws): a Recraft Reel must never silently become a stock Reel.
 */
export async function loadReelRecraft(service: SupabaseClient, requestId: string): Promise<ReelRecraftRow | null> {
  const { data, error } = await service.from("video_requests")
    .select("reel_image_source, reel_recraft_style, reel_recraft_style_id").eq("id", requestId).maybeSingle();
  if (error) {
    if (error.code === "42703" || error.code === "PGRST204") return null;
    throw new Error("No se pudo leer la configuración de imágenes Recraft de este Reel. No se ha cobrado nada.");
  }
  const row = data as { reel_image_source?: string | null; reel_recraft_style?: unknown; reel_recraft_style_id?: string | null } | null;
  if (!row || row.reel_image_source !== "recraft") return null;
  const style = parseStoredRecraftStyle(row.reel_recraft_style);
  if (!style) throw new Error("La configuración de estilo Recraft de este Reel está incompleta. No se ha cobrado nada.");
  return { style, styleId: row.reel_recraft_style_id ?? style.styleId };
}

/** USD envelope for the Recraft images of this attempt (one per scene + style creation if no style_id yet). */
export function recraftDemandUsd(recraft: ReelRecraftRow | null, script: unknown): number {
  if (!recraft) return 0;
  const n = (script as GeneratedScript | null)?.segments?.length ?? 0;
  return recraftReelEstimateUsd(n, Boolean(recraft.styleId));
}

/** Short-lived signed URLs for the user's reference images (fal needs a fetchable URL; nothing is made public). */
export async function signReferenceUrls(service: SupabaseClient, paths: string[], ttlSeconds = 3600): Promise<string[]> {
  const urls: string[] = [];
  for (const p of paths) {
    const { data, error } = await service.storage.from(BUCKET).createSignedUrl(p, ttlSeconds);
    if (error || !data?.signedUrl) throw new Error("No se pudo preparar una imagen de referencia de estilo. No se ha cobrado nada.");
    urls.push(data.signedUrl);
  }
  return urls;
}

/** Persists the style_id fal returned, once (null → value). The DB trigger refuses any later change. */
export async function persistReelStyleId(service: SupabaseClient, requestId: string, styleId: string): Promise<void> {
  const { error } = await service.from("video_requests").update({ reel_recraft_style_id: styleId })
    .eq("id", requestId).is("reel_recraft_style_id", null);
  if (error) throw new Error("No se pudo guardar el style_id de Recraft de este Reel; se detiene para no crear estilos distintos.");
}

/**
 * Validates (real PNG/JPEG/WEBP header matching the declared type, ≤ 5 MB) and stores the creator's style references
 * under `${folder}/ref-N.ext` in our private bucket. Nothing is sent to fal.ai and nothing is paid. Returns the stored
 * paths, or a user-facing error (Spanish) without storing anything further. Shared by the Reel form and Long Form.
 */
export async function storeRecraftReferences(service: SupabaseClient, folder: string, files: File[]): Promise<{ paths: string[] } | { error: string }> {
  const paths: string[] = [];
  for (const [n, f] of files.slice(0, RECRAFT_MAX_REFERENCES).entries()) {
    const buf = Buffer.from(await f.arrayBuffer());
    const dim = imageDimensions(buf);
    const ext = RECRAFT_REFERENCE_TYPES[f.type];
    if (!ext || buf.byteLength > RECRAFT_MAX_REFERENCE_BYTES || !dim || dim.type !== f.type) {
      return { error: "Las imágenes de referencia deben ser PNG, JPG o WEBP válidas de hasta 5 MB. No se ha creado ni cobrado nada." };
    }
    const path = `${folder}/ref-${n}.${ext}`;
    const up = await service.storage.from(BUCKET).upload(path, buf, { contentType: f.type, upsert: true });
    if (up.error) return { error: "No se pudieron guardar las imágenes de referencia. No se ha creado ni cobrado nada." };
    paths.push(path);
  }
  return { paths };
}
