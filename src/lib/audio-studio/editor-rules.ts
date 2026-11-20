import { VOICE_PRESETS, type StudioLanguage } from "./model";

/**
 * Duración escrita en el editor: el campo acepta texto libre mientras se edita (se puede vaciar y reescribir) y solo
 * se confirma un número entero dentro de [min, max]. Antes se recortaba en cada pulsación: al borrar volvía el 5 y
 * escribir «30» acababa en 35, 53 o 60.
 */
export function parseTargetMinutes(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number.parseInt(t, 10);
  return n >= min && n <= max ? n : null;
}

/** Al salir del campo: un número fuera de rango se lleva al límite más cercano; vacío o no numérico conserva el anterior. */
export function commitTargetMinutes(text: string, previous: number, min: number, max: number): number {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return previous;
  return Math.min(max, Math.max(min, Number.parseInt(t, 10)));
}

/**
 * Voces elegidas que el catálogo real no ofrece con el modelo actual bloquean «Generar». Propone sustitutas del mismo
 * idioma que sí estén disponibles (mismo género primero, sin repetir voz). null si no hay sustituta para alguna.
 */
export function voiceReplacements(voices: string[], language: StudioLanguage, available: (id: string) => boolean): string[] | null {
  const next = [...voices];
  let changed = false;
  for (let i = 0; i < next.length; i++) {
    if (available(next[i])) continue;
    const gender = VOICE_PRESETS.find((p) => p.id === next[i])?.gender;
    const pool = VOICE_PRESETS.filter((p) => p.language === language && available(p.id) && !next.includes(p.id));
    const alt = pool.find((p) => p.gender === gender) ?? pool[0];
    if (!alt) return null;
    next[i] = alt.id;
    changed = true;
  }
  return changed ? next : null;
}
