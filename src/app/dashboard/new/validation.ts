import type { AvatarJobStatus } from "@/lib/providers/avatar";

/**
 * Validación pura (sin I/O) del formulario de /dashboard/new — separada de
 * actions.ts para poder probarla con node:test sin necesitar un contexto
 * de Server Action de Next.js (cookies()/redirect() solo funcionan dentro
 * de una request real). Nunca confiar en la validación del cliente
 * (AvatarFields.tsx/NewVideoForm.tsx) — esta es la que de verdad decide.
 */

// Duraciones que ofrece el formulario — se valida contra esta misma lista
// en el servidor (nunca confiar solo en el <select> del cliente) para no
// dejar pasar una duración arbitraria que dispare un guion/voz/render
// desproporcionado. Ver también el CHECK de la migración 0007.
export const ALLOWED_DURATIONS = [30, 60, 90];
export const ALLOWED_LANGUAGES = ["es", "en"] as const;
export const MAX_TOPIC_LENGTH = 500;
export const MAX_STYLE_LENGTH = 100;
export const MAX_AVATAR_NAME_LENGTH = 80;

export function validateCommonFields(fields: {
  topic: string;
  style: string;
  durationSeconds: number;
  language: string;
}): string | null {
  const { topic, style, durationSeconds, language } = fields;
  if (!topic || !style || !durationSeconds) {
    return "Completa todos los campos";
  }
  if (!ALLOWED_LANGUAGES.includes(language as (typeof ALLOWED_LANGUAGES)[number])) {
    return "Idioma no válido";
  }
  if (topic.length > MAX_TOPIC_LENGTH) {
    return `El tema no puede superar ${MAX_TOPIC_LENGTH} caracteres`;
  }
  if (style.length > MAX_STYLE_LENGTH) {
    return `El estilo no puede superar ${MAX_STYLE_LENGTH} caracteres`;
  }
  if (!ALLOWED_DURATIONS.includes(durationSeconds)) {
    return "Duración no válida";
  }
  return null;
}

export type VideoMode = "visual" | "avatar";

/**
 * Decide el modo real de la solicitud a partir de lo enviado por el
 * cliente. El modo avatar SOLO es válido si además el flag del servidor
 * (AVATAR_MODE_ENABLED, leído por el caller — nunca por este módulo) está
 * encendido — un POST manual con mode=avatar mientras el flag está
 * apagado se trata igual que un modo inválido, no como "modo visual por
 * defecto".
 */
export function resolveMode(
  rawMode: string,
  avatarModeEnabled: boolean,
): { ok: true; mode: VideoMode } | { ok: false; error: string } {
  if (rawMode !== "visual" && rawMode !== "avatar") {
    return { ok: false, error: "Modo no válido" };
  }
  if (rawMode === "avatar" && !avatarModeEnabled) {
    return { ok: false, error: "El modo avatar no está disponible" };
  }
  return { ok: true, mode: rawMode };
}

/** El checkbox "required" del cliente es solo ayuda de UX — esta es la verificación real. */
export function isAvatarConsentGiven(rawValue: FormDataEntryValue | null): boolean {
  return rawValue === "on";
}

export function validateNewAvatarSubmission(fields: {
  hasPhotoFile: boolean;
  photoSizeBytes: number;
  avatarName: string;
}): string | null {
  const { hasPhotoFile, photoSizeBytes, avatarName } = fields;
  if (!hasPhotoFile || photoSizeBytes === 0) {
    return "Falta la fotografía del avatar";
  }
  if (!avatarName) {
    return "Falta el nombre del avatar";
  }
  if (avatarName.length > MAX_AVATAR_NAME_LENGTH) {
    return `El nombre del avatar no puede superar ${MAX_AVATAR_NAME_LENGTH} caracteres`;
  }
  return null;
}

/** Traduce el estado del proveedor (HeyGen/fixture) al estado que guarda public.avatars. */
export function avatarStatusFromProviderStatus(status: AvatarJobStatus): "processing" | "ready" | "failed" {
  if (status === "completed") return "ready";
  if (status === "failed" || status === "cancelled") return "failed";
  return "processing";
}
