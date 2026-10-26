/** Podcast 2.1 Estudio — estado del asistente de 10 pasos (puro: cliente y pruebas). Borrador persistido en localStorage
 * (y el episodio creado, en el servidor): volver atrás o recargar no pierde la configuración. */
import type { Mood, StudioMode, StudioSet } from "./spec";

export const WIZARD_STORAGE_KEY = "atomivid.podcast.asistente.v2";
/** Tope por episodio que el servidor y la BD hacen cumplir (STUDIO_MAX_AUTHORIZED_USD en api.ts; CHECK ≤ 50 en 140000).
 * El asistente lo aplica ya en «Presupuesto» para no dejar avanzar hasta un 402 al final del recorrido. */
export const STUDIO_BUDGET_MAX_USD = 50;
export const STEPS = ["Modalidad", "Tema", "Participantes", "Voces", "Avatares", "Música", "Visuales", "Presupuesto", "Vista previa", "Generación"] as const;
export const STEP = { modalidad: 0, tema: 1, participantes: 2, voces: 3, avatares: 4, musica: 5, visuales: 6, presupuesto: 7, vista: 8, generacion: 9 } as const;
/**
 * Modalidad visible para el usuario → modo del estudio.
 *  A «audio»: solo audio (1–2 voces, música opcional, MP3/WAV); NO se renderiza video.
 *  B «visual»: narración audiovisual con imágenes relacionadas, transiciones y música → MP4 + audio.
 *  C «avatar» / «dialogo»: uno o dos avatares con lip-sync alternados con imágenes → MP4 + audio.
 */
export type Modality = "audio" | "visual" | "avatar" | "dialogo";
export const MODALITIES: readonly Modality[] = ["audio", "visual", "avatar", "dialogo"];
export const MODALITY_LABEL: Record<Modality, string> = { audio: "Solo audio", visual: "Narración con imágenes (video)", avatar: "Presentador con avatar", dialogo: "Conversación con dos avatares" };
export const INTENSITY_DB = { suave: -28, media: -22, alta: -17 } as const;
export const modalityToMode = (m: Modality): StudioMode => (m === "audio" || m === "visual" ? "narracion" : m);
export type AvatarChoice = { kind: "ninguno" } | { kind: "existente"; avatar_id: string } | { kind: "foto"; photo_path: string; consent: boolean; consent_at: string | null };
export type WizardParticipant = { name: string; role: string; gender: "femenino" | "masculino" | "neutro"; style: string; personality: string; voice_id: string; voice_kind: "sintetica" | "clonada"; avatar: AvatarChoice };
export type WizardDraft = {
  step: number; modality: Modality | null; mode: StudioMode | null; language: "es" | "en"; provider: "pexels" | "recraft" | "solo_set";
  intensity: "suave" | "media" | "alta"; intro: boolean; outro: boolean; ducking: boolean; title: string; topic: string; script: string; minutes: number; count: 1 | 2;
  participants: [WizardParticipant, WizardParticipant];
  set: StudioSet; swap: boolean; subtitles: boolean; avatarFrequency: number; avatarMaxSeconds: number; recreations: boolean;
  musicEnabled: boolean; mood: Mood | "auto"; volumeDb: number; stings: boolean; ambient: "ninguno" | "lluvia" | "viento" | "noche";
  format: "16:9" | "9:16"; audioExport: "mp3" | "wav"; budgetUsd: number; authorized: boolean; episodeId: string | null; draftId?: string | null;
};
const P = (name: string): WizardParticipant => ({ name, role: "", gender: "neutro", style: "", personality: "", voice_id: "", voice_kind: "sintetica", avatar: { kind: "ninguno" } });
export const defaultDraft = (): WizardDraft => ({ step: 0, modality: null, mode: null, language: "es", provider: "pexels", intensity: "media", intro: true, outro: true, ducking: true, title: "", topic: "", script: "", minutes: 5, count: 1, participants: [P("Anfitrión"), P("Invitado")],
  set: "estudio_oscuro", swap: false, subtitles: true, avatarFrequency: 0.5, avatarMaxSeconds: 20, recreations: true,
  musicEnabled: true, mood: "auto", volumeDb: -22, stings: true, ambient: "ninguno", format: "16:9", audioExport: "mp3", budgetUsd: 10, authorized: false, episodeId: null });

/** Carga tolerante: un borrador viejo o corrupto nunca rompe la página (se mezclan con los valores por defecto). */
export function loadDraft(raw: string | null): WizardDraft {
  if (!raw) return defaultDraft();
  try { const d = JSON.parse(raw); const base = defaultDraft(); return { ...base, ...d, participants: [{ ...base.participants[0], ...(d.participants?.[0] ?? {}) }, { ...base.participants[1], ...(d.participants?.[1] ?? {}) }] }; }
  catch { return defaultDraft(); }
}

/** Errores que impiden avanzar desde un paso (mensajes para personas no técnicas). */
export function stepErrors(d: WizardDraft, step: number, ctx: { unavailableVoices: string[]; providers?: { id: string; available: boolean; reason: string | null }[] }): string[] {
  const e: string[] = [];
  const active = d.participants.slice(0, d.count);
  if (step === STEP.modalidad && !d.modality) e.push("Elige cómo quieres tu podcast.");
  if (step === STEP.tema) {
    if (!d.title.trim()) e.push("Escribe un título.");
    if (d.script.trim().length < 20) e.push(d.mode === "dialogo" ? "Pega un guion con nombres (por ejemplo «Ana: …») o genera la conversación desde el tema." : "Escribe o pega el texto del episodio (mínimo 20 caracteres).");
  }
  if (step === STEP.participantes) for (const p of active) if (!p.name.trim()) e.push("Cada participante necesita un nombre.");
  if (step === STEP.voces) {
    for (const p of active) {
      if (!p.voice_id) e.push(`Elige una voz para ${p.name}.`);
      else if (ctx.unavailableVoices.includes(p.voice_id)) e.push(`La voz elegida para ${p.name} no está disponible; elige otra.`);
    }
    if (d.count === 2 && active[0].voice_id && active[0].voice_id === active[1].voice_id) e.push("Los dos participantes necesitan voces distintas.");
  }
  if (step === STEP.avatares && d.mode !== "narracion") for (const p of active) {
    if (p.avatar.kind === "ninguno") e.push(`Elige un avatar para ${p.name}.`);
    if (p.avatar.kind === "foto" && !p.avatar.consent) e.push(`Marca el consentimiento para crear el avatar de ${p.name} desde su foto.`);
    if (p.avatar.kind === "foto" && !p.avatar.photo_path) e.push(`Sube la foto de ${p.name}.`);
  }
  if (step === STEP.visuales && d.modality !== "audio") {
    const pr = ctx.providers?.find((x) => x.id === d.provider);
    if (pr && !pr.available) e.push(`${pr.reason ?? "Proveedor no disponible."} Elige otro proveedor (no se cambia automáticamente).`);
  }
  if (step === STEP.presupuesto && !(d.budgetUsd > 0)) e.push("Define un presupuesto máximo mayor que cero.");
  if (step === STEP.presupuesto && d.budgetUsd > STUDIO_BUDGET_MAX_USD) e.push(`Por seguridad, un episodio no puede autorizar más de USD ${STUDIO_BUDGET_MAX_USD}. Baja el presupuesto o divide el episodio.`);
  if (step === STEP.generacion && !d.authorized) e.push("Marca la casilla para autorizar el cargo.");
  return e;
}

export const CONSENT_TEXT = "Confirmo que soy la persona de la foto o tengo su permiso expreso, y autorizo crear un avatar digital con ella para este podcast.";

/** Especificación del estudio a partir del borrador. */
export function draftToSpec(d: WizardDraft) {
  const ids = ["A", "B"] as const;
  return {
    mode: d.mode, title: d.title.trim(), topic: d.topic.trim(), script: d.script.trim(), target_minutes: d.minutes, language: d.language,
    participants: d.participants.slice(0, d.count).map((p, i) => ({ id: ids[i], name: p.name.trim() || ids[i], role: p.role, gender: p.gender, style: p.style, personality: p.personality, voice_id: p.voice_id, voice_kind: p.voice_kind,
      avatar: p.avatar.kind === "foto" ? { kind: "foto", photo_path: p.avatar.photo_path, consent: { given: p.avatar.consent, at: p.avatar.consent_at ?? new Date().toISOString(), text: CONSENT_TEXT } } : p.avatar })),
    visual: { set: d.set, swap_sides: d.swap, subtitles: d.subtitles, avatar_frequency: d.avatarFrequency, avatar_max_seconds: d.avatarMaxSeconds, recreations: d.recreations && d.provider === "recraft", provider: d.modality === "audio" ? "solo_set" : d.provider },
    output: d.modality === "audio" ? "audio" : "video",
    music: { enabled: d.musicEnabled, mood: d.mood, volume_db: d.volumeDb, stings: d.stings, ambient: d.ambient, intensity: d.intensity, intro: d.intro, outro: d.outro, ducking: d.ducking },
    format: d.format, audio_export: d.audioExport, budget_usd: d.budgetUsd,
  };
}

/** Modo A sin estudio activado: crea un episodio del flujo actual (Podcast 2.x) con música y 1–2 voces. */
export function draftToV2(d: WizardDraft, v2Enabled: boolean) {
  const [a, b] = d.participants;
  const two = d.count === 2 && v2Enabled;
  const script = two ? d.script.split(/\n\s*\n/).map((p, i) => `${i % 2 ? "B" : "A"}: ${p.trim()}`).filter((x) => x.length > 3).join("\n\n") : d.script;
  return { title: d.title.trim(), script, language: d.language, voiceId: a.voice_id,
    production: v2Enabled ? { mode: two ? "conversation" : "single", style: "emotional", music: d.musicEnabled, dialogue: script,
      participants: [{ id: "A", name: a.name, voiceId: a.voice_id }, ...(two ? [{ id: "B", name: b.name, role: b.role, voiceId: b.voice_id }] : [])] } : null };
}

export const estimateMinutes = (script: string) => Math.max(0.1, script.trim().length / 15 / 60);
