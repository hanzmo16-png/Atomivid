/**
 * «Mi voz» — reglas puras de la muestra y del consentimiento (sin I/O).
 */

/** Versión del texto de consentimiento; se guarda con cada voz (cambiar el texto = nueva versión). */
export const VOICE_CONSENT_VERSION = "2026-09-26";

export const VOICE_CONSENT_TEXT = {
  ownVoice: "La voz de la muestra es mía, o tengo autorización expresa y por escrito de la persona para clonarla.",
  processing:
    "Entiendo que la muestra se envía a ElevenLabs para crear una voz privada que solo yo puedo usar en Atomivid, que el resultado es una aproximación y no una copia perfecta, y que puedo eliminarla cuando quiera.",
} as const;

export const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;
export const MIN_SAMPLE_SECONDS = 30;
export const MAX_SAMPLE_SECONDS = 180;
export const VOICE_NAME_MAX = 40;

export type SampleFormat = { extension: "wav" | "mp3" | "m4a" | "webm" | "ogg"; mimeType: string };

/** Formato por los bytes (nunca por el nombre ni el tipo que declare el navegador). */
export function detectSampleFormat(bytes: Uint8Array): SampleFormat | null {
  if (bytes.length < 12) return null;
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return { extension: "wav", mimeType: "audio/wav" };
  if (ascii(4, 8) === "ftyp") return { extension: "m4a", mimeType: "audio/mp4" };
  if (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return { extension: "mp3", mimeType: "audio/mpeg" };
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { extension: "webm", mimeType: "audio/webm" };
  if (ascii(0, 4) === "OggS") return { extension: "ogg", mimeType: "audio/ogg" };
  return null;
}

export function sampleDurationIssue(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return "No se pudo leer la duración de la muestra.";
  if (seconds < MIN_SAMPLE_SECONDS) return `La muestra dura ${Math.round(seconds)} s; necesita al menos ${MIN_SAMPLE_SECONDS} s de voz.`;
  if (seconds > MAX_SAMPLE_SECONDS) return `La muestra dura ${Math.round(seconds)} s; el máximo es ${MAX_SAMPLE_SECONDS / 60} min.`;
  return null;
}

export function validateVoiceName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, error: "Ponle un nombre a tu voz." };
  if (name.length > VOICE_NAME_MAX) return { ok: false, error: `El nombre admite hasta ${VOICE_NAME_MAX} caracteres.` };
  return { ok: true, name };
}

export const userVoicePrefix = (userId: string, voiceId: string) => `voices/${userId}/${voiceId}`;
export const samplePath = (userId: string, voiceId: string, extension: string) => `${userVoicePrefix(userId, voiceId)}/sample.${extension}`;
export const testAudioPath = (userId: string, voiceId: string) => `${userVoicePrefix(userId, voiceId)}/test.mp3`;

/** Frase de la prueba corta, por idioma de la muestra (se genera una vez al terminar de clonar). */
export const VOICE_TEST_TEXT = "Hola, esta es mi voz en Atomivid. Así sonará la narración de mis videos y audios.";
