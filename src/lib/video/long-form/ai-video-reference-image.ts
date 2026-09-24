/**
 * P2B preparation — ingesta de una IMAGEN DE REFERENCIA APROBADA
 * (image-to-video) para el benchmark activo de video-IA. Provider-agnóstico
 * y reutiliza el mismo bucket/patrón de checksum ya usado por
 * ai-video-storage.ts (nunca un almacenamiento específico de Veo).
 *
 * Este módulo NUNCA decide si una imagen está "aprobada" — esa es una
 * decisión humana (ver ai-video-benchmark-v2-active.ts,
 * ReferenceImageSpec.status) que ocurre FUERA de este código. Aquí solo se
 * valida el archivo (formato/dimensiones/integridad/tamaño) y se sube.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MIN_BYTES = 1024;
const MAX_BYTES = 20 * 1024 * 1024;
const TARGET_ASPECT_RATIO = 16 / 9;
/** Tolerancia razonable: los generadores de imagen IA rara vez dan un 16:9 exacto en píxeles (p. ej. 1672x941 = 1.7768 vs 1.7778 real). */
const MAX_ASPECT_RATIO_DEVIATION_PERCENT = 2;

export type ReferenceImageValidationResult =
  | {
      valid: true;
      format: "png" | "jpeg" | "webp";
      widthPx?: number;
      heightPx?: number;
      aspectRatioDeviationPercent?: number;
    }
  | { valid: false; reason: string };

/** PNG: firma de 8 bytes + chunk IHDR obligatorio como primer chunk — ancho/alto en big-endian en offsets fijos (16-19 / 20-23). Único formato con parseo de dimensiones exacto en este módulo (ver comentario de detectFormat). */
function parsePng(buffer: Buffer): { widthPx: number; heightPx: number } | null {
  if (buffer.length < 24) return null;
  if (buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { widthPx: buffer.readUInt32BE(16), heightPx: buffer.readUInt32BE(20) };
}

/** JPEG: escanea marcadores hasta encontrar un SOF (0xC0-0xCF, excluyendo 0xC4/0xC8/0xCC que no son SOF) — altura/anchura en los 4 bytes siguientes a la longitud del segmento. */
function parseJpeg(buffer: Buffer): { widthPx: number; heightPx: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const heightPx = buffer.readUInt16BE(offset + 5);
      const widthPx = buffer.readUInt16BE(offset + 7);
      return { widthPx, heightPx };
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }
  return null;
}

function detectFormat(buffer: Buffer): "png" | "jpeg" | "webp" | null {
  if (buffer.length >= 8 && buffer.toString("hex", 0, 8) === "89504e470d0a1a0a") return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

/**
 * Valida un buffer de imagen de referencia: formato, tamaño no vacío/no
 * absurdamente grande, integridad estructural mínima (encabezados/chunks
 * bien formados), y — cuando el formato lo permite parsear con certeza
 * (PNG y JPEG) — dimensiones y desviación de 16:9. WebP se reconoce por
 * formato pero sin parseo de dimensiones propio (fuera de alcance de este
 * módulo; no bloquea el uso, solo omite el chequeo de aspect ratio para
 * ese formato en vez de arriesgar un parseo VP8/VP8L/VP8X incorrecto).
 */
export function validateReferenceImageBuffer(buffer: Buffer, declaredMimeType: string): ReferenceImageValidationResult {
  if (!ALLOWED_MIME_TYPES.has(declaredMimeType)) {
    return { valid: false, reason: `tipo MIME no permitido para una imagen de referencia: "${declaredMimeType}"` };
  }
  if (buffer.byteLength < MIN_BYTES) {
    return { valid: false, reason: `archivo demasiado pequeño para ser una imagen real (${buffer.byteLength} bytes)` };
  }
  if (buffer.byteLength > MAX_BYTES) {
    return { valid: false, reason: `archivo demasiado grande (${buffer.byteLength} bytes, máximo ${MAX_BYTES})` };
  }

  const format = detectFormat(buffer);
  if (!format) {
    return { valid: false, reason: "el contenido del archivo no coincide con ningún formato de imagen soportado (png/jpeg/webp)" };
  }
  const expectedMime = format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp";
  if (expectedMime !== declaredMimeType) {
    return { valid: false, reason: `el mimeType declarado ("${declaredMimeType}") no coincide con el contenido real detectado (${format})` };
  }

  const dims = format === "png" ? parsePng(buffer) : format === "jpeg" ? parseJpeg(buffer) : null;
  if ((format === "png" || format === "jpeg") && !dims) {
    return { valid: false, reason: `no se pudieron leer las dimensiones — encabezado ${format.toUpperCase()} corrupto o incompleto` };
  }
  if (!dims) {
    return { valid: true, format };
  }
  if (dims.widthPx <= 0 || dims.heightPx <= 0) {
    return { valid: false, reason: `dimensiones inválidas (${dims.widthPx}x${dims.heightPx})` };
  }
  const actualRatio = dims.widthPx / dims.heightPx;
  const deviationPercent = (Math.abs(actualRatio - TARGET_ASPECT_RATIO) / TARGET_ASPECT_RATIO) * 100;
  if (deviationPercent > MAX_ASPECT_RATIO_DEVIATION_PERCENT) {
    return {
      valid: false,
      reason: `aspect ratio ${actualRatio.toFixed(4)} (${dims.widthPx}x${dims.heightPx}) se desvía ${deviationPercent.toFixed(2)}% de 16:9, por encima de la tolerancia (${MAX_ASPECT_RATIO_DEVIATION_PERCENT}%)`,
    };
  }

  return { valid: true, format, widthPx: dims.widthPx, heightPx: dims.heightPx, aspectRatioDeviationPercent: deviationPercent };
}

export function computeReferenceImageChecksumSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Mismo bucket que el resto de Long Form (ai-video-storage.ts, visual-test-v2-storage.ts) — nunca uno nuevo. */
export const REFERENCE_IMAGE_STORAGE_BUCKET = "videos";

export function referenceImageStoragePath(benchmarkId: string, shotId: string, checksumSha256: string, extension: string): string {
  return `long-form/${benchmarkId}/reference-images/${shotId}-${checksumSha256.slice(0, 16)}.${extension}`;
}

export type CanonicalReferenceImageAsset = {
  bucket: string;
  storagePath: string;
  checksumSha256: string;
  widthPx?: number;
  heightPx?: number;
  format: "png" | "jpeg" | "webp";
};

export class ReferenceImageInvalidError extends Error {
  constructor(public readonly reason: string) {
    super(`Imagen de referencia inválida: ${reason}`);
    this.name = "ReferenceImageInvalidError";
  }
}

/**
 * Valida y sube una imagen de referencia ya APROBADA (la aprobación es
 * responsabilidad del llamador, nunca de esta función) a Supabase Storage,
 * devolviendo su referencia canónica — idempotente por checksum. Lanza
 * ReferenceImageInvalidError si la validación falla; NUNCA sube un archivo
 * que no pasó validate.
 */
export async function ingestApprovedReferenceImage(
  supabase: SupabaseClient,
  buffer: Buffer,
  params: { benchmarkId: string; shotId: string; declaredMimeType: string; bucket?: string },
): Promise<CanonicalReferenceImageAsset> {
  const validation = validateReferenceImageBuffer(buffer, params.declaredMimeType);
  if (!validation.valid) throw new ReferenceImageInvalidError(validation.reason);

  const bucket = params.bucket ?? REFERENCE_IMAGE_STORAGE_BUCKET;
  const checksumSha256 = computeReferenceImageChecksumSha256(buffer);
  const extension = validation.format === "jpeg" ? "jpg" : validation.format;
  const storagePath = referenceImageStoragePath(params.benchmarkId, params.shotId, checksumSha256, extension);

  const { error } = await supabase.storage.from(bucket).upload(storagePath, buffer, { contentType: params.declaredMimeType, upsert: true });
  if (error) throw new Error(`No se pudo subir la imagen de referencia a Storage ("${storagePath}"): ${error.message}`);

  return { bucket, storagePath, checksumSha256, widthPx: validation.widthPx, heightPx: validation.heightPx, format: validation.format };
}
