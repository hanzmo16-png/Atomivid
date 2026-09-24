/**
 * Validación del buffer devuelto por un VideoProvider ANTES de subirlo a
 * Storage o de pasarlo al renderer — mismo principio que
 * visual-asset-validation.ts (nunca confiar en que "la llamada no lanzó"
 * ya implica "es un archivo de video real y usable"), pero para video en
 * vez de imagen. Se mantiene como módulo propio (no una extensión del
 * validador de imágenes) porque las reglas de formato/tamaño son
 * distintas — mismo criterio ya documentado en visual-asset-validation.ts
 * para no generalizar photo-validation.ts.
 *
 * El proveedor fixture de video (providers/video-gen/fixture.ts) NO
 * devuelve bytes MP4 reales — un placeholder de texto determinístico, sin
 * red, para poder probar el flujo completo sin generar nada real (ver su
 * propio comentario). Este validador lo reconoce explícitamente por su
 * firma literal, exactamente como visual-asset-validation.ts reconoce el
 * SVG del fixture de imágenes como un formato válido aparte — nunca se
 * confunde con un archivo MP4 real (el `format` devuelto distingue "mp4"
 * real de "fixture-placeholder").
 */

const ALLOWED_MIME_TYPES = new Set(["video/mp4", "video/webm"]);
const FIXTURE_SIGNATURE = "atomivid-fixture-video-clip:";
const MIN_BYTES = 32;
const MAX_BYTES = 500 * 1024 * 1024;
const MIN_DURATION_SECONDS = 0.5;
const MAX_DURATION_SECONDS = 60;

export type VideoAssetValidationResult =
  | { valid: true; format: "mp4" | "webm" | "fixture-placeholder" }
  | { valid: false; reason: string };

/** MP4/MOV real: ftyp box en el offset 4 (después de los 4 bytes de tamaño). WebM/MKV real: firma EBML. Ninguno de los dos requiere decodificar el archivo entero. */
function detectRealFormat(buffer: Buffer): "mp4" | "webm" | null {
  if (buffer.length >= 8 && buffer.toString("ascii", 4, 8) === "ftyp") return "mp4";
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return "webm";
  return null;
}

function isFixturePlaceholder(buffer: Buffer): boolean {
  return buffer.subarray(0, FIXTURE_SIGNATURE.length).toString("utf8") === FIXTURE_SIGNATURE;
}

/**
 * Valida el buffer y (best-effort, sin decodificar el archivo) la
 * duración/dimensiones declaradas por el proveedor — un proveedor real
 * puede mentir sobre su propia metadata, pero al menos se descarta un
 * valor absurdo o fuera del rango razonable para un clip de Long Form.
 */
export function validateVideoAssetBuffer(
  buffer: Buffer,
  declaredMimeType: string,
  declared?: { durationSeconds?: number; widthPx?: number; heightPx?: number },
): VideoAssetValidationResult {
  if (!ALLOWED_MIME_TYPES.has(declaredMimeType)) {
    return { valid: false, reason: `tipo MIME no permitido para un clip de video generado: "${declaredMimeType}"` };
  }
  if (buffer.byteLength < MIN_BYTES) {
    return { valid: false, reason: `archivo demasiado pequeño para ser un clip de video (${buffer.byteLength} bytes)` };
  }
  if (buffer.byteLength > MAX_BYTES) {
    return { valid: false, reason: `archivo demasiado grande (${buffer.byteLength} bytes, máximo ${MAX_BYTES})` };
  }

  if (isFixturePlaceholder(buffer)) {
    // El fixture nunca declara video/webm con bytes reales — es válido
    // COMO fixture (para ejercitar el flujo completo), nunca confundido
    // con un resultado real por el llamador (que decide qué hacer con
    // `format === "fixture-placeholder"`, típicamente rechazarlo fuera
    // de modo simulation — ver ai-video-resolver.ts).
    return { valid: true, format: "fixture-placeholder" };
  }

  const format = detectRealFormat(buffer);
  if (!format) {
    return { valid: false, reason: "el contenido del archivo no coincide con ningún formato de video soportado (mp4/webm) ni con la firma del fixture" };
  }
  const expectedMime = format === "mp4" ? "video/mp4" : "video/webm";
  if (expectedMime !== declaredMimeType) {
    return { valid: false, reason: `el proveedor dijo "${declaredMimeType}" pero el contenido real es ${format}` };
  }

  if (declared?.durationSeconds !== undefined) {
    if (declared.durationSeconds < MIN_DURATION_SECONDS || declared.durationSeconds > MAX_DURATION_SECONDS) {
      return {
        valid: false,
        reason: `duración declarada fuera de rango razonable (${declared.durationSeconds}s, esperado ${MIN_DURATION_SECONDS}-${MAX_DURATION_SECONDS}s)`,
      };
    }
  }
  if (declared?.widthPx !== undefined && declared?.heightPx !== undefined) {
    if (declared.widthPx <= 0 || declared.heightPx <= 0) {
      return { valid: false, reason: `dimensiones declaradas inválidas (${declared.widthPx}x${declared.heightPx})` };
    }
  }

  return { valid: true, format };
}
