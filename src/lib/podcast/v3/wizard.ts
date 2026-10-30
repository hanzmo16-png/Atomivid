/** Podcast 2.1 Estudio — estado del asistente de 10 pasos (puro: cliente y pruebas). Borrador persistido en localStorage
 * (y el episodio creado, en el servidor): volver atrás o recargar no pierde la configuración. */
import type { Mood, StudioMode, StudioSet } from "./spec";
import { DURATION_TOLERANCE, OPEN_CLOSE_SECONDS, SPOKEN_CHARS_PER_SECOND, TURN_GAP_SECONDS } from "./script";
import { STUDIO_IDS, legacyStudio } from "./studios";
import { catalogHost, type CatalogHost } from "./catalog";

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
export type AvatarChoice = { kind: "ninguno" } | { kind: "existente"; avatar_id: string } | { kind: "foto"; photo_path: string; consent: boolean; consent_at: string | null } | { kind: "catalogo"; host_id: CatalogHost["id"] };
/** `host`: anfitrión del catálogo (su voz y su avatar vienen con él); null = personalizado (voz y avatar propios). */
export type WizardParticipant = { name: string; role: string; gender: "femenino" | "masculino" | "neutro"; style: string; personality: string; voice_id: string; voice_kind: "sintetica" | "clonada"; avatar: AvatarChoice; host?: CatalogHost["id"] | null };
export type WizardDraft = {
  step: number; modality: Modality | null; mode: StudioMode | null; language: "es" | "en"; provider: "recraft" | "solo_set";
  intensity: "suave" | "media" | "alta"; intro: boolean; outro: boolean; ducking: boolean; title: string; topic: string; script: string; minutes: number; count: 1 | 2;
  participants: [WizardParticipant, WizardParticipant];
  set: StudioSet; swap: boolean; subtitles: boolean; avatarFrequency: number; avatarMaxSeconds: number; recreations: boolean;
  musicEnabled: boolean; mood: Mood | "auto"; volumeDb: number; stings: boolean; ambient: "ninguno" | "lluvia" | "viento" | "noche";
  format: "16:9" | "9:16"; audioExport: "mp3" | "wav"; budgetUsd: number; authorized: boolean; episodeId: string | null; draftId?: string | null;
  /** Configuración con la que se creó `draftId`/`episodeId` (specKey). Si cambia, el borrador suelta ese episodio. */
  boundSpec?: string | null;
};
const P = (name: string): WizardParticipant => ({ name, role: "", gender: "neutro", style: "", personality: "", voice_id: "", voice_kind: "sintetica", avatar: { kind: "ninguno" }, host: null });

/** Elegir un anfitrión del catálogo carga su nombre, estilo, voz y avatar (no hay que escoger voz). */
export function withHost(p: WizardParticipant, hostId: CatalogHost["id"]): WizardParticipant {
  const h = catalogHost(hostId);
  if (!h) return p;
  return { ...p, host: h.id, name: h.name, role: h.role, gender: h.gender, style: h.style, personality: h.personality, voice_id: h.voiceId, voice_kind: "sintetica", avatar: { kind: "catalogo", host_id: h.id } };
}
/** Volver a «Personalizado»: se quitan la voz y el avatar del anfitrión (la configuración propia se elige aparte). */
export function withoutHost(p: WizardParticipant): WizardParticipant {
  if (!p.host) return p;
  return { ...p, host: null, voice_id: "", voice_kind: "sintetica", avatar: { kind: "ninguno" } };
}

/** Clon privado concedido → «clonada»; catálogo o id vacío → «sintetica». La UI y el envío usan la misma regla. */
export function voiceKindFor(voiceId: string, catalog: readonly { voiceId: string; kind?: "sintetica" | "clonada" }[]): "sintetica" | "clonada" {
  if (!voiceId) return "sintetica";
  return catalog.find((v) => v.voiceId === voiceId)?.kind === "clonada" ? "clonada" : "sintetica";
}

export function withVoiceKinds(d: WizardDraft, catalog: readonly { voiceId: string; kind?: "sintetica" | "clonada" }[]): WizardDraft {
  const participants = d.participants.map((p) => {
    if (!p.voice_id) return p.voice_kind === "sintetica" ? p : { ...p, voice_kind: "sintetica" as const };
    const known = catalog.find((v) => v.voiceId === p.voice_id);
    // Catálogo vacío o aún sin esta voz: no degradar un clon ya guardado (un fallo al listar voces no debe reescribir el borrador).
    if (!known) return p;
    const voice_kind = known.kind === "clonada" ? "clonada" : "sintetica";
    return voice_kind === p.voice_kind ? p : { ...p, voice_kind };
  }) as WizardDraft["participants"];
  if (participants.every((p, i) => p === d.participants[i])) return d;
  return { ...d, participants };
}
export const defaultDraft = (): WizardDraft => ({ step: 0, modality: null, mode: null, language: "es", provider: "recraft", intensity: "media", intro: true, outro: true, ducking: true, title: "", topic: "", script: "", minutes: 5, count: 1, participants: [P("Anfitrión"), P("Invitado")],
  set: "moderno", swap: false, subtitles: true, avatarFrequency: 0.5, avatarMaxSeconds: 20, recreations: true,
  musicEnabled: true, mood: "auto", volumeDb: -22, stings: true, ambient: "ninguno", format: "16:9", audioExport: "mp3", budgetUsd: 10, authorized: false, episodeId: null });

/** Carga tolerante: un borrador viejo o corrupto nunca rompe la página (se mezclan con los valores por defecto). */
export function loadDraft(raw: string | null): WizardDraft {
  if (!raw) return defaultDraft();
  try {
    const d = JSON.parse(raw); const base = defaultDraft();
    const out: WizardDraft = { ...base, ...d, participants: [{ ...base.participants[0], ...(d.participants?.[0] ?? {}) }, { ...base.participants[1], ...(d.participants?.[1] ?? {}) }] };
    // Borradores anteriores: Pexels ya no está en el estudio (→ Recraft) y los escenarios de color pasan a su estudio compartido.
    if ((out.provider as string) === "pexels") out.provider = "recraft";
    if (!(STUDIO_IDS as readonly string[]).includes(out.set)) out.set = legacyStudio(out.set);
    return out;
  }
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
    else if (durationFit(d.script, d.minutes) === "largo") e.push(`El guion dura unos ${estimateMinutes(d.script).toFixed(1)} min y el objetivo es ${d.minutes} min: acórtalo o sube la duración (la voz no se acelera para que quepa).`);
  }
  if (step === STEP.participantes) for (const p of active) if (!p.name.trim()) e.push("Cada participante necesita un nombre.");
  if (step === STEP.voces) {
    for (const p of active) {
      if (p.host) continue; // la voz del anfitrión del catálogo ya viene con él
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

/** Nombres por defecto de los participantes (antes de elegir anfitrión o escribir un nombre). */
export const DEFAULT_NAMES = ["Anfitrión", "Invitado"] as const;
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Cambia un nombre en el guion: la etiqueta de cada turno («Nombre: …») y las menciones dentro del texto (palabra
 * completa, respetando mayúsculas: «invitado» como palabra común no se toca). Auditoría 2026-10-30 (episodio 51883d1c):
 * el guion se generaba antes de elegir a los participantes y salió con «me acompaña Invitado» y «Gracias a ti,
 * Anfitrión» aunque B era Valeria Montclair.
 */
export function renameInScript(script: string, from: string, to: string): string {
  const a = from.trim(), b = to.trim();
  if (!script || !a || !b || a === b) return script;
  const word = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(a)}(?![\\p{L}\\p{N}])`, "gu");
  return script.split("\n").map((line) => line.replace(word, b)).join("\n");
}

/** Mantiene el guion al día con los nombres: si un participante cambia de nombre, el guion lo sigue. */
export function syncScriptNames(prev: WizardDraft, next: WizardDraft): WizardDraft {
  let script = next.script;
  next.participants.forEach((p, i) => {
    const before = prev.participants[i]?.name ?? "";
    if (before.trim() && p.name.trim() && before.trim() !== p.name.trim()) script = renameInScript(script, before, p.name);
  });
  return script === next.script ? next : { ...next, script };
}

/** Nombre de pila a partir del nombre de un avatar propio («Hans Estudio podcast» → «Hans»). */
export function firstNameOf(avatarName: string): string {
  const w = avatarName.trim().split(/\s+/)[0] ?? "";
  return /^\p{Lu}[\p{L}'-]{1,30}$/u.test(w) ? w : "";
}

/** Elegir un avatar propio: si el participante seguía con el nombre por defecto, toma el nombre del avatar. */
export function withOwnAvatar(p: WizardParticipant, avatar: { id: string; name: string }, i: 0 | 1): WizardParticipant {
  const name = !p.name.trim() || p.name === DEFAULT_NAMES[i] ? firstNameOf(avatar.name) || p.name : p.name;
  return { ...p, host: null, name, avatar: { kind: "existente", avatar_id: avatar.id } };
}

/** Especificación del estudio a partir del borrador. */
/** Huella de lo que se produciría: exactamente lo que se envía al crear el episodio. */
export function specKey(d: WizardDraft): string { return JSON.stringify(draftToSpec(d)); }

/** El borrador deja de apuntar a un episodio: la próxima «Generación» crea uno nuevo (el anterior queda intacto). */
export const releaseEpisode = (d: WizardDraft): WizardDraft => ({ ...d, episodeId: null, draftId: null, authorized: false, boundSpec: null });

/**
 * Incidente 2026-10-29 (falso 0 % → 100 %): el borrador guardado en el navegador conservaba `episodeId`/`draftId` de una
 * producción terminada. Al volver atrás y configurar OTRO podcast, «Generación» mostraba el avance del episodio anterior
 * (ya listo) y no creaba nada. Regla: un episodio queda ligado a la configuración con la que se creó (`boundSpec`);
 * si cambia, el borrador lo suelta. Revisar los pasos sin cambiar nada no lo suelta (no se crea ni cobra otro).
 * Borradores anteriores a esta regla (sin huella): se conservan solo mientras siguen en «Generación».
 */
export function bindEpisode(d: WizardDraft): WizardDraft {
  if (!d.episodeId && !d.draftId) return d.boundSpec ? { ...d, boundSpec: null } : d;
  if (d.boundSpec == null) return d.step === STEP.generacion ? { ...d, boundSpec: specKey(d) } : releaseEpisode(d);
  return d.boundSpec === specKey(d) ? d : releaseEpisode(d);
}

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

/** Minutos de episodio que dará el guion al ritmo real de las voces (cortinas y pausas entre turnos incluidas). */
export function estimateMinutes(script: string): number {
  const lines = script.trim().split(/\n+/).filter((l) => l.trim());
  const chars = lines.reduce((n, l) => n + l.replace(/^\s*[^:]{1,40}:\s*/, "").trim().length, 0);
  return Math.max(0.1, (OPEN_CLOSE_SECONDS + chars / SPOKEN_CHARS_PER_SECOND + lines.length * TURN_GAP_SECONDS) / 60);
}
/** «largo» si el guion pasa de la duración pedida más la tolerancia; «corto» si queda por debajo. */
export function durationFit(script: string, minutes: number): "ok" | "largo" | "corto" {
  const m = estimateMinutes(script);
  return m > minutes * (1 + DURATION_TOLERANCE) ? "largo" : m < minutes * (1 - DURATION_TOLERANCE) ? "corto" : "ok";
}
