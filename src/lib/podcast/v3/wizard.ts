/** Podcast 3.0 — estado del asistente por pasos (puro: cliente y pruebas). Borrador persistido en localStorage. */
import type { Mood, StudioMode, StudioSet } from "./spec";

export const WIZARD_STORAGE_KEY = "atomivid.podcast.asistente.v1";
export const STEPS = ["Modo", "Tema o guion", "Duración", "Participantes", "Voces y avatares", "Escenario", "Música", "Formato", "Costo estimado", "Autorizar", "Progreso", "Reproducir", "Descargar", "Mis episodios"] as const;
export type AvatarChoice = { kind: "ninguno" } | { kind: "existente"; avatar_id: string } | { kind: "foto"; photo_path: string; consent: boolean; consent_at: string | null };
export type WizardParticipant = { name: string; role: string; voice_id: string; voice_kind: "sintetica" | "clonada"; avatar: AvatarChoice };
export type WizardDraft = {
  step: number; mode: StudioMode | null; title: string; topic: string; script: string; minutes: number; count: 1 | 2;
  participants: [WizardParticipant, WizardParticipant];
  set: StudioSet; swap: boolean; subtitles: boolean; avatarFrequency: number; avatarMaxSeconds: number; recreations: boolean;
  musicEnabled: boolean; mood: Mood | "auto"; volumeDb: number; stings: boolean; ambient: "ninguno" | "lluvia" | "viento" | "noche";
  format: "16:9" | "9:16"; audioExport: "mp3" | "wav"; budgetUsd: number; authorized: boolean; episodeId: string | null;
};
const P = (name: string): WizardParticipant => ({ name, role: "", voice_id: "", voice_kind: "sintetica", avatar: { kind: "ninguno" } });
export const defaultDraft = (): WizardDraft => ({ step: 0, mode: null, title: "", topic: "", script: "", minutes: 5, count: 1, participants: [P("Anfitrión"), P("Invitado")],
  set: "estudio_oscuro", swap: false, subtitles: true, avatarFrequency: 0.5, avatarMaxSeconds: 20, recreations: true,
  musicEnabled: true, mood: "auto", volumeDb: -22, stings: true, ambient: "ninguno", format: "16:9", audioExport: "mp3", budgetUsd: 10, authorized: false, episodeId: null });

/** Carga tolerante: un borrador viejo o corrupto nunca rompe la página (se mezclan con los valores por defecto). */
export function loadDraft(raw: string | null): WizardDraft {
  if (!raw) return defaultDraft();
  try { const d = JSON.parse(raw); const base = defaultDraft(); return { ...base, ...d, participants: [{ ...base.participants[0], ...(d.participants?.[0] ?? {}) }, { ...base.participants[1], ...(d.participants?.[1] ?? {}) }] }; }
  catch { return defaultDraft(); }
}

/** Errores que impiden avanzar desde un paso (mensajes para personas no técnicas). */
export function stepErrors(d: WizardDraft, step: number, ctx: { unavailableVoices: string[] }): string[] {
  const e: string[] = [];
  const active = d.participants.slice(0, d.count);
  if (step === 0 && !d.mode) e.push("Elige cómo quieres tu podcast.");
  if (step === 1) {
    if (!d.title.trim()) e.push("Escribe un título.");
    if (d.script.trim().length < 20) e.push(d.mode === "dialogo" ? "Pega un guion con nombres (por ejemplo «Ana: …») o genera la conversación desde el tema." : "Escribe o pega el texto del episodio (mínimo 20 caracteres).");
  }
  if (step === 3) for (const p of active) if (!p.name.trim()) e.push("Cada participante necesita un nombre.");
  if (step === 4) {
    for (const p of active) {
      if (!p.voice_id) e.push(`Elige una voz para ${p.name}.`);
      else if (ctx.unavailableVoices.includes(p.voice_id)) e.push(`La voz elegida para ${p.name} no está disponible; elige otra.`);
      if (d.mode !== "narracion" && p.avatar.kind === "ninguno") e.push(`Elige un avatar para ${p.name}.`);
      if (p.avatar.kind === "foto" && !p.avatar.consent) e.push(`Marca el consentimiento para crear el avatar de ${p.name} desde su foto.`);
      if (p.avatar.kind === "foto" && !p.avatar.photo_path) e.push(`Sube la foto de ${p.name}.`);
    }
    if (d.count === 2 && active[0].voice_id && active[0].voice_id === active[1].voice_id) e.push("Los dos participantes necesitan voces distintas.");
  }
  if (step === 8 && !(d.budgetUsd > 0)) e.push("Define un presupuesto máximo mayor que cero.");
  if (step === 9 && !d.authorized) e.push("Marca la casilla para autorizar el cargo.");
  return e;
}

export const CONSENT_TEXT = "Confirmo que soy la persona de la foto o tengo su permiso expreso, y autorizo crear un avatar digital con ella para este podcast.";

/** Especificación del estudio a partir del borrador. */
export function draftToSpec(d: WizardDraft) {
  const ids = ["A", "B"] as const;
  return {
    mode: d.mode, title: d.title.trim(), topic: d.topic.trim(), script: d.script.trim(), target_minutes: d.minutes, language: "es",
    participants: d.participants.slice(0, d.count).map((p, i) => ({ id: ids[i], name: p.name.trim() || ids[i], role: p.role, voice_id: p.voice_id, voice_kind: p.voice_kind,
      avatar: p.avatar.kind === "foto" ? { kind: "foto", photo_path: p.avatar.photo_path, consent: { given: p.avatar.consent, at: p.avatar.consent_at ?? new Date().toISOString(), text: CONSENT_TEXT } } : p.avatar })),
    visual: { set: d.set, swap_sides: d.swap, subtitles: d.subtitles, avatar_frequency: d.avatarFrequency, avatar_max_seconds: d.avatarMaxSeconds, recreations: d.recreations },
    music: { enabled: d.musicEnabled, mood: d.mood, volume_db: d.volumeDb, stings: d.stings, ambient: d.ambient },
    format: d.format, audio_export: d.audioExport, budget_usd: d.budgetUsd,
  };
}

/** Modo A sin estudio activado: crea un episodio del flujo actual (Podcast 2.x) con música y 1–2 voces. */
export function draftToV2(d: WizardDraft, v2Enabled: boolean) {
  const [a, b] = d.participants;
  const two = d.count === 2 && v2Enabled;
  const script = two ? d.script.split(/\n\s*\n/).map((p, i) => `${i % 2 ? "B" : "A"}: ${p.trim()}`).filter((x) => x.length > 3).join("\n\n") : d.script;
  return { title: d.title.trim(), script, language: "es", voiceId: a.voice_id,
    production: v2Enabled ? { mode: two ? "conversation" : "single", style: "emotional", music: d.musicEnabled, dialogue: script,
      participants: [{ id: "A", name: a.name, voiceId: a.voice_id }, ...(two ? [{ id: "B", name: b.name, role: b.role, voiceId: b.voice_id }] : [])] } : null };
}

export const estimateMinutes = (script: string) => Math.max(0.1, script.trim().length / 15 / 60);
