/** Shared upload limits; actual decoding and duration checks run in the worker. */
export const MAX_RECORDING_BYTES = 3 * 1024 * 1024;
export const MAX_AVATAR_FORM_BYTES = 3 * 1024 * 1024;
export const RECORDING_BUCKET = "avatar-uploads";

export function recordingFormat(bytes: Uint8Array): { extension: string; mimeType: string } {
  if (!bytes.length || bytes.length > MAX_RECORDING_BYTES) throw new Error("Audio vacío o mayor de 3 MB.");
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
