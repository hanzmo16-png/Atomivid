/**
 * Límites reales e INDEPENDIENTES de foto y audio — nunca combinados.
 *
 * QA blocker real (2026-09-25, Android/Samsung): el límite histórico era
 * foto+audio <= 3 MB combinados (MAX_AVATAR_FORM_BYTES, heredado de una
 * prueba privada D-ID muy temprana). Una grabación nativa de ~45s desde
 * el picker de archivos de Android (que en móvil ofrece "grabar" además
 * de "elegir archivo") puede pesar varios MB incluso comprimida (M4A/AAC
 * de buena calidad, o WAV si el grabador nativo del dispositivo no
 * comprime) — la app dejaba grabar los 45s completos y RECIÉN AL FINAL
 * rechazaba el conjunto. MAX_RECORDING_BYTES (solo audio, generoso para
 * cubrir hasta ~90s incluso en WAV sin comprimir a 44.1kHz/16-bit/stereo:
 * ~10.5 MB para 60s, ~15.75 MB para 90s) y MAX_AVATAR_PHOTO_BYTES (solo
 * foto, generoso para una foto de cámara de teléfono moderna sin
 * recomprimir) reemplazan ese límite combinado.
 */
export const MAX_RECORDING_BYTES = 16 * 1024 * 1024;
export const MAX_AVATAR_PHOTO_BYTES = 8 * 1024 * 1024;
export const RECORDING_BUCKET = "avatar-uploads";

export function recordingFormat(bytes: Uint8Array): { extension: string; mimeType: string } {
  if (!bytes.length || bytes.length > MAX_RECORDING_BYTES) throw new Error(`Audio vacío o mayor de ${Math.round(MAX_RECORDING_BYTES / 1024 / 1024)} MB.`);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return { extension: "wav", mimeType: "audio/wav" };
  if (ascii(4, 8) === "ftyp" && ["M4A ", "isom", "mp42", "iso2", "3gp4", "3gp5", "3gp6"].includes(ascii(8, 12))) return { extension: "m4a", mimeType: "audio/mp4" };
  if (ascii(0, 3) === "ID3" || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return { extension: "mp3", mimeType: "audio/mpeg" };
  throw new Error("Formato de audio no reconocido. Usa M4A, MP3 o WAV.");
}

export function recordingPath(userId: string, requestId: string, extension: string): string {
  if (![userId, requestId].every(v => /^[a-zA-Z0-9-]+$/.test(v)) || !["wav", "mp3", "m4a"].includes(extension)) throw new Error("Ruta de grabación inválida.");
  return `${userId}/${requestId}/recording.${extension}`;
}

export function isOwnedRecordingPath(value: string, userId: string, requestId: string): boolean {
  return ["wav", "mp3", "m4a"].some(ext => value === recordingPath(userId, requestId, ext));
}
