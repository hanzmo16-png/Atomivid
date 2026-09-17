/**
 * Validación de la fotografía subida para crear un avatar — sin
 * dependencias externas (mismo criterio que providers/music/validate.ts:
 * nada garantizado en el runtime de producción más allá de Node puro).
 * Reconoce el formato por "magic bytes" (nunca confía solo en la
 * extensión o el Content-Type declarado por el navegador) y extrae
 * dimensiones directamente del header de PNG/JPEG para poder rechazar
 * archivos sospechosos o demasiado pequeños/grandes ANTES de subir nada
 * a Storage o de gastar una llamada al proveedor de avatar.
 */

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIN_BYTES = 4096; // por debajo de esto, casi seguro no es una foto real.
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — generoso para una foto de retrato, acota el costo de subida/proveedor.
const MIN_DIMENSION_PX = 200;
const MAX_DIMENSION_PX = 8000;

export type PhotoValidationResult =
  | { valid: true; format: "jpeg" | "png" | "webp"; width?: number; height?: number }
  | { valid: false; reason: string };

function detectFormat(buffer: Buffer): "jpeg" | "png" | "webp" | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer.toString("ascii", 1, 4) === "PNG"
  ) {
    return "png";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  // IHDR siempre es el primer chunk: firma (8) + longitud (4) + "IHDR" (4) + ancho (4) + alto (4).
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  // Recorre los marcadores JPEG buscando un SOFn (Start Of Frame), que
  // trae alto/ancho — el resto de marcadores solo se saltan por su
  // longitud declarada, sin decodificar la imagen.
  let offset = 2; // salta 0xFFD8
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }
  return null;
}

export function validatePhotoBuffer(buffer: Buffer, declaredMimeType: string): PhotoValidationResult {
  if (!ALLOWED_MIME_TYPES.has(declaredMimeType)) {
    return { valid: false, reason: `tipo MIME no permitido: "${declaredMimeType}"` };
  }
  if (buffer.byteLength < MIN_BYTES) {
    return { valid: false, reason: `archivo demasiado pequeño para ser una foto real (${buffer.byteLength} bytes)` };
  }
  if (buffer.byteLength > MAX_BYTES) {
    return { valid: false, reason: `archivo demasiado grande (${buffer.byteLength} bytes, máximo ${MAX_BYTES})` };
  }

  const format = detectFormat(buffer);
  if (!format) {
    return { valid: false, reason: "el contenido del archivo no coincide con ningún formato de imagen soportado (jpeg/png/webp)" };
  }
  // El MIME declarado debe coincidir con lo que dicen los bytes reales —
  // nunca confiar solo en el Content-Type que manda el navegador.
  const expectedMime = format === "jpeg" ? "image/jpeg" : format === "png" ? "image/png" : "image/webp";
  if (expectedMime !== declaredMimeType) {
    return { valid: false, reason: `el archivo dice ser "${declaredMimeType}" pero su contenido real es ${format}` };
  }

  const dimensions = format === "png" ? readPngDimensions(buffer) : format === "jpeg" ? readJpegDimensions(buffer) : null;
  if (dimensions) {
    if (dimensions.width < MIN_DIMENSION_PX || dimensions.height < MIN_DIMENSION_PX) {
      return { valid: false, reason: `imagen demasiado pequeña (${dimensions.width}x${dimensions.height}px, mínimo ${MIN_DIMENSION_PX}px)` };
    }
    if (dimensions.width > MAX_DIMENSION_PX || dimensions.height > MAX_DIMENSION_PX) {
      return { valid: false, reason: `imagen demasiado grande (${dimensions.width}x${dimensions.height}px, máximo ${MAX_DIMENSION_PX}px)` };
    }
    return { valid: true, format, width: dimensions.width, height: dimensions.height };
  }

  // WEBP (o un JPEG/PNG sin header de dimensiones legible): se acepta
  // por tipo, sin bloquear por dimensión — limitación documentada, no
  // oculta como si se hubiera verificado.
  return { valid: true, format };
}
