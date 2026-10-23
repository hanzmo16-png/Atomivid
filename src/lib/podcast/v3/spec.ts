/**
 * Podcast 3.0 — especificación de un episodio de estudio (modos A/B/C). Pura (cliente y servidor), sin red.
 *  A «narracion»: narración cinematográfica con 1–2 voces, imágenes del relato, música por ambiente.
 *  B «avatar»: un avatar que habla (HeyGen) alternado con imágenes/recreaciones; apariciones acotadas por costo.
 *  C «dialogo»: dos participantes (A = avatar del usuario, B = invitado) con voces independientes; planos
 *     individuales, two-shot y sobre el hombro COMPUESTOS por FFmpeg a partir de clips renderizados por separado.
 * Principio editorial: VERACIDAD NARRATIVA > CALIDAD > CONSISTENCIA > COSTO > VELOCIDAD.
 */
import { z } from "zod";
import { canUsePrivateVoice, isPrivateVoice, parsePrivateVoiceGrants, visibleVoices, type VoiceViewer } from "@/lib/voices/private-voices";
import type { AccountVoice } from "@/lib/podcast/voices";

export const STUDIO_VERSION = "podcast-studio/3" as const;
export const MODES = ["narracion", "avatar", "dialogo"] as const;
export type StudioMode = (typeof MODES)[number];
export const MOODS = ["misterio", "suspenso", "epico", "documental", "relajante", "inspirador", "tension", "nostalgico"] as const;
export type Mood = (typeof MOODS)[number];
export const SETS = ["estudio_oscuro", "estudio_calido", "biblioteca", "neon", "minimalista"] as const;
export type StudioSet = (typeof SETS)[number];
export const AMBIENTS = ["ninguno", "lluvia", "viento", "noche"] as const;
/** Voz privada El Duro (clon del dueño): nunca se sustituye por otra. */
export const EL_DURO_VOICE_ID = "CeFSZuaHs4SxcBxb9nCr";

export const MODE_LABEL: Record<StudioMode, string> = {
  narracion: "Narración cinematográfica",
  avatar: "Un avatar presentador",
  dialogo: "Conversación entre dos participantes",
};
export const MOOD_LABEL: Record<Mood, string> = {
  misterio: "Misterio", suspenso: "Suspenso", epico: "Épico", documental: "Documental", relajante: "Relajante",
  inspirador: "Inspirador", tension: "Tensión", nostalgico: "Nostálgico",
};
export const SET_LABEL: Record<StudioSet, string> = {
  estudio_oscuro: "Estudio oscuro", estudio_calido: "Estudio cálido", biblioteca: "Biblioteca", neon: "Neón", minimalista: "Minimalista",
};

const VoiceId = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/);
export const StudioParticipant = z.object({
  id: z.enum(["A", "B"]),
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().max(120).default(""),
  voice_id: VoiceId,
  voice_kind: z.enum(["sintetica", "clonada"]).default("sintetica"),
  /** Avatar existente del usuario (id interno o del proveedor), o "foto" con consentimiento explícito. */
  avatar: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ninguno") }),
    z.object({ kind: z.literal("existente"), avatar_id: z.string().min(1).max(200) }),
    z.object({ kind: z.literal("foto"), photo_path: z.string().min(1).max(400).regex(/^[^.][^\0]*$/).refine((p) => !p.includes(".."), "Ruta inválida"), consent: z.object({ given: z.literal(true), at: z.string(), text: z.string().min(10) }) }),
  ]).default({ kind: "ninguno" }),
});
export type StudioParticipant = z.infer<typeof StudioParticipant>;

export const StudioSpec = z.object({
  version: z.literal(STUDIO_VERSION),
  mode: z.enum(MODES),
  title: z.string().trim().min(1).max(200),
  language: z.enum(["es", "en"]).default("es"),
  topic: z.string().trim().max(500).default(""),
  script: z.string().trim().min(20).max(30_000),
  target_minutes: z.number().min(1).max(60),
  participants: z.array(StudioParticipant).min(1).max(2),
  visual: z.object({
    set: z.enum(SETS).default("estudio_oscuro"),
    swap_sides: z.boolean().default(false),
    subtitles: z.boolean().default(true),
    /** Proporción de turnos en que aparece el avatar (B/C) y máximo de segundos por aparición: controlan el costo. */
    avatar_frequency: z.number().min(0).max(1).default(0.5),
    avatar_max_seconds: z.number().min(3).max(120).default(20),
    recreations: z.boolean().default(true),
  }),
  music: z.object({
    enabled: z.boolean().default(true),
    mood: z.enum([...MOODS, "auto"] as const).default("auto"),
    volume_db: z.number().min(-40).max(-12).default(-22),
    stings: z.boolean().default(true),
    ambient: z.enum(AMBIENTS).default("ninguno"),
  }),
  format: z.enum(["16:9", "9:16"]).default("16:9"),
  audio_export: z.enum(["mp3", "wav"]).default("mp3"),
  budget_usd: z.number().min(0).max(500),
});
export type StudioSpec = z.infer<typeof StudioSpec>;

export type SpecIssue = { field: string; message: string };

/** Valida reglas de negocio que el esquema no expresa (participantes por modo, voces visibles, El Duro, consentimiento). */
export function validateSpec(spec: StudioSpec, voices: AccountVoice[], viewer: VoiceViewer, env: Record<string, string | undefined> = process.env): SpecIssue[] {
  const out: SpecIssue[] = [];
  const need = spec.mode === "dialogo" ? 2 : spec.mode === "avatar" ? 1 : null;
  if (need && spec.participants.length !== need) out.push({ field: "participants", message: need === 2 ? "La conversación necesita exactamente dos participantes." : "El modo avatar usa un solo participante." });
  if (new Set(spec.participants.map((p) => p.id)).size !== spec.participants.length) out.push({ field: "participants", message: "Participantes repetidos." });
  const visible = visibleVoices(voices, viewer, env);
  for (const p of spec.participants) {
    const v = voices.find((x) => x.voiceId === p.voice_id);
    if (p.voice_id === EL_DURO_VOICE_ID && !canUsePrivateVoice(EL_DURO_VOICE_ID, viewer, env)) out.push({ field: `voice_${p.id}`, message: "La voz El Duro no está autorizada para esta cuenta; no se sustituye por otra." });
    else if (!visible.some((x) => x.voiceId === p.voice_id)) out.push({ field: `voice_${p.id}`, message: `La voz elegida para ${p.name} no está disponible.` });
    else if (v && isPrivateVoice(v) && !canUsePrivateVoice(v.voiceId, viewer, env)) out.push({ field: `voice_${p.id}`, message: "Voz privada no autorizada." });
    if ((spec.mode === "avatar" || spec.mode === "dialogo") && p.avatar.kind === "ninguno") out.push({ field: `avatar_${p.id}`, message: `Elige un avatar para ${p.name}.` });
    if (p.avatar.kind === "foto" && !p.avatar.consent?.given) out.push({ field: `avatar_${p.id}`, message: "Falta el consentimiento explícito para crear el avatar desde la foto." });
  }
  if (spec.mode === "dialogo" && spec.participants.length === 2 && spec.participants[0].voice_id === spec.participants[1].voice_id) out.push({ field: "voice_B", message: "Los dos participantes necesitan voces distintas." });
  return out;
}

/**
 * Voces para la UI. El Duro: si NO hay concesión configurada para nadie (falta PRIVATE_VOICE_GRANTS), se muestra
 * «No disponible» para que el dueño sepa por qué (nunca se sustituye). Si está concedida a otra cuenta, se oculta
 * a las demás (privacidad).
 */
export function voiceAvailability(voices: AccountVoice[], viewer: VoiceViewer, env: Record<string, string | undefined> = process.env) {
  const visible = visibleVoices(voices, viewer, env);
  const list = visible.map((v) => ({ voiceId: v.voiceId, name: v.name, available: true, note: isPrivateVoice(v) ? "Voz clonada" : null as string | null }));
  if (!list.some((v) => v.voiceId === EL_DURO_VOICE_ID) && !parsePrivateVoiceGrants(env.PRIVATE_VOICE_GRANTS).has(EL_DURO_VOICE_ID)) list.push({ voiceId: EL_DURO_VOICE_ID, name: "El Duro (Hans)", available: false, note: "No disponible: requiere autorización (PRIVATE_VOICE_GRANTS)." });
  return list;
}
