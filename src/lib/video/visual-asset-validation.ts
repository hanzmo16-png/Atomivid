/**
 * Validación del archivo devuelto por un proveedor de imagen (OpenAI real
 * o el fixture determinístico) ANTES de subirlo a Storage o de usarlo en
 * el render — mismo principio que video/avatar/photo-validation.ts
 * (nunca confiar solo en que "la llamada no lanzó error" ya implica "es
 * un archivo de imagen real y usable"), pero con sus propias reglas: los
 * proveedores de imagen generada pueden devolver PNG (OpenAI real) O SVG
 * (el fixture, sin red — ver providers/image/fixture.ts), a diferencia de
 * las fotos subidas por usuarios (siempre jpeg/png/webp). Se duplica
 * deliberadamente un poco de detección de magic bytes en vez de
 * generalizar photo-validation.ts — mantiene ambos validadores aislados y
 * sin riesgo de que un cambio en uno rompa al otro.
 */

const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
// El fixture genera un SVG de texto muy pequeño — un mínimo alto como el
// de fotos reales (photo-validation.ts usa 4096) rechazaría un fixture
// válido. 64 bytes basta para descartar un buffer vacío o truncado.
const MIN_BYTES = 64;
const MAX_BYTES = 10 * 1024 * 1024;
const MIN_DIMENSION_PX = 200;
const MAX_DIMENSION_PX = 8000;

export type VisualAssetValidationResult =
  | { valid: true; format: "png" | "jpeg" | "webp" | "svg"; width?: number; height?: number }
  | { valid: false; reason: string };

function detectFormat(buffer: Buffer): "png" | "jpeg" | "webp" | "svg" | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString("ascii", 1, 4) === "PNG") return "png";
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  // SVG es texto, no binario — se detecta por contenido, no por magic
  // bytes fijos. Se limita a los primeros bytes para no escanear un
  // archivo entero que en realidad no sea SVG.
  const head = buffer.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "svg";
  return null;
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function validateVisualAssetBuffer(buffer: Buffer, declaredMimeType: string): VisualAssetValidationResult {
  if (!ALLOWED_MIME_TYPES.has(declaredMimeType)) {
    return { valid: false, reason: `tipo MIME no permitido para un recurso visual generado: "${declaredMimeType}"` };
  }
  if (buffer.byteLength < MIN_BYTES) {
    return { valid: false, reason: `archivo demasiado pequeño para ser una imagen real (${buffer.byteLength} bytes)` };
  }
  if (buffer.byteLength > MAX_BYTES) {
    return { valid: false, reason: `archivo demasiado grande (${buffer.byteLength} bytes, máximo ${MAX_BYTES})` };
  }

  const format = detectFormat(buffer);
  if (!format) {
    return { valid: false, reason: "el contenido del archivo no coincide con ningún formato soportado (png/jpeg/webp/svg)" };
  }
  const expectedMime =
    format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/svg+xml";
  if (expectedMime !== declaredMimeType) {
    return { valid: false, reason: `el proveedor dijo "${declaredMimeType}" pero el contenido real es ${format}` };
  }

  if (format === "png") {
    const dimensions = readPngDimensions(buffer);
    if (dimensions) {
      if (dimensions.width < MIN_DIMENSION_PX || dimensions.height < MIN_DIMENSION_PX) {
        return { valid: false, reason: `imagen demasiado pequeña (${dimensions.width}x${dimensions.height}px)` };
      }
      if (dimensions.width > MAX_DIMENSION_PX || dimensions.height > MAX_DIMENSION_PX) {
        return { valid: false, reason: `imagen demasiado grande (${dimensions.width}x${dimensions.height}px)` };
      }
      return { valid: true, format, width: dimensions.width, height: dimensions.height };
    }
  }

  // jpeg/webp/svg: aceptados por formato sin verificar dimensiones —
  // limitación documentada (igual criterio que photo-validation.ts),
  // nunca presentada como una verificación que en realidad no ocurrió.
  return { valid: true, format };
}
