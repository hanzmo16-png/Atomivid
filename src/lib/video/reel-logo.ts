import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";

export const REEL_LOGO_BUCKET = "reel-logos";
export const MAX_REEL_LOGO_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function reelLogoPath(userId: string, requestId: string): string {
  if (!UUID.test(userId) || !UUID.test(requestId)) throw new Error("Solicitud de logo inválida.");
  return `${userId}/${requestId}/logo.png`;
}

/** Decode and re-encode untrusted PNGs; preserve transparency, remove metadata. */
export async function normalizeReelLogo(buffer: Buffer, mimeType: string): Promise<Buffer> {
  if (mimeType !== "image/png" || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("El logo debe ser un archivo PNG. Recomendamos fondo transparente.");
  }
  if (!buffer.length || buffer.length > MAX_REEL_LOGO_BYTES) throw new Error("El logo no puede superar 1 MB.");
  try {
    const image = sharp(buffer, { limitInputPixels: 2048 * 2048, failOn: "warning" });
    const meta = await image.metadata();
    if (!meta.width || !meta.height || meta.width < 16 || meta.height < 16 || meta.width > 2048 || meta.height > 2048 || (meta.pages ?? 1) > 1) {
      throw new Error("dimensions");
    }
    return await image.resize({ width: 400, height: 240, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  } catch {
    throw new Error("No se pudo leer el logo. Usa un PNG válido de 16 a 2048 píxeles por lado.");
  }
}

/** The worker downloads only this request's asset, before any paid provider call. */
export async function loadReelLogo(
  service: SupabaseClient,
  userId: string,
  requestId: string,
  logoPath: string | null | undefined,
): Promise<string | undefined> {
  if (!logoPath) return undefined;
  if (logoPath !== reelLogoPath(userId, requestId)) throw new Error("El logo no pertenece a esta solicitud.");
  const { data, error } = await service.storage.from(REEL_LOGO_BUCKET).download(logoPath);
  if (error || !data || data.size > MAX_REEL_LOGO_BYTES) throw new Error("No se pudo recuperar tu logo. No se inició la generación del video.");
  const normalized = await normalizeReelLogo(Buffer.from(await data.arrayBuffer()), "image/png");
  return `data:image/png;base64,${normalized.toString("base64")}`;
}
