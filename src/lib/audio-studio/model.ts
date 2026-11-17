/**
 * Audio Podcast Studio 1.0 — modelo puro (sin red, sin base de datos).
 *
 * Un proyecto es un episodio de audio editable: título, una o dos voces, guion, música de fondo y presupuesto.
 * Este módulo es independiente de Podcast Studio Premium (src/lib/podcast/**): no importa nada de allí ni escribe en
 * sus tablas. La generación real con un proveedor de voz no se ejecuta en 1.0 sin una autorización posterior; el
 * proyecto solo puede quedar «listo para autorizar».
 */

export const MODULE_VERSION = "audio-studio-1.0";
export const MAX_TITLE = 200;
export const MAX_SCRIPT = 60_000;
export const MAX_NOTES = 2_000;
export const MIN_TARGET_MINUTES = 5;
export const MAX_TARGET_MINUTES = 60;
/** Ritmo de narración en español usado para estimar la duración (palabras por minuto). */
export const WORDS_PER_MINUTE = 150;
/** Tarifa de voz por 1 000 caracteres. 0.20 es la tarifa configurada en producción (la más conservadora conocida). */
export const DEFAULT_VOICE_USD_PER_1K_CHARS = 0.2;

/**
 * Modelos de voz seleccionables. «verified» indica si las capacidades y la tarifa se comprobaron contra la cuenta real
 * (GET /v1/models y facturación). Mientras no lo estén, el estudio:
 *  - estima con la tarifa CONSERVADORA (la de producción para Multilingual v2), nunca con la de lista más barata;
 *  - envía solo los parámetros comprobados (stability y similarity_boost), sin style/speed/break/previous_text.
 * Multilingual v2 es el modelo por defecto y el respaldo explícito: un fallo nunca cambia de modelo solo.
 */
export type TtsModelId = "eleven_multilingual_v2" | "eleven_v4_turbo";
export type TtsModel = {
  id: TtsModelId; label: string; description: string;
  /** Tarifa de lista API (USD / 1 000 caracteres) según fuentes públicas; solo informativa. */
  listUsdPer1k: number;
  /** Máximo de caracteres por solicitud. */
  maxCharsPerRequest: number;
  /** Ajustes de voz que se envían al proveedor (los no comprobados no se envían). */
  voiceSettings: readonly ("stability" | "similarity_boost" | "style" | "use_speaker_boost")[];
  verified: boolean; fallback: boolean;
};
export const TTS_MODELS: readonly TtsModel[] = [
  { id: "eleven_multilingual_v2", label: "Multilingual v2 (estándar)", description: "Modelo actual de Atomivid. Máxima estabilidad en narraciones largas.",
    listUsdPer1k: 0.08, maxCharsPerRequest: 10_000, voiceSettings: ["stability", "similarity_boost", "style", "use_speaker_boost"], verified: true, fallback: true },
  { id: "eleven_v4_turbo", label: "V4 Turbo (preferido)", description: "Voces en español e inglés. El costo se estima de forma conservadora.",
    listUsdPer1k: 0.04, maxCharsPerRequest: 10_000, voiceSettings: ["stability", "similarity_boost"], verified: false, fallback: false },
];
export const DEFAULT_TTS_MODEL: TtsModelId = "eleven_v4_turbo";
export const FALLBACK_TTS_MODEL: TtsModelId = "eleven_multilingual_v2";
export const ttsModel = (id: string): TtsModel | null => TTS_MODELS.find((m) => m.id === id) ?? null;
export const DEFAULT_BUDGET_USD = 6;
export const MAX_BUDGET_USD = 20;

export type StudioLanguage = "es" | "en";
export const LANGUAGES = [{ id: "es", label: "Español" }, { id: "en", label: "English" }] as const;

export type VoiceGender = "masculina" | "femenina";
export type VoicePreset = { id: string; label: string; gender: VoiceGender; accent: string; style: string; language: StudioLanguage };

/**
 * Catálogo curado por idioma. El servidor comprueba disponibilidad y compatibilidad en la cuenta antes de generar.
 */
export const VOICE_PRESETS: readonly VoicePreset[] = [
  { id: "es-latam-m-profesional", label: "Víctor", gender: "masculina", accent: "Latinoamericano", style: "Profesional", language: "es" },
  { id: "es-latam-m-calida", label: "Mateo", gender: "masculina", accent: "Latinoamericano", style: "Conversacional", language: "es" },
  { id: "es-latam-f-profesional", label: "Ximena", gender: "femenina", accent: "Mexicano", style: "Suave y envolvente", language: "es" },
  { id: "es-latam-f-energica", label: "Tiara Gogh", gender: "femenina", accent: "Mexicano", style: "Narración", language: "es" },
  { id: "en-us-m-roger", label: "Roger", gender: "masculina", accent: "American", style: "Casual, resonant", language: "en" },
  { id: "en-us-f-sarah", label: "Sarah", gender: "femenina", accent: "American", style: "Reassuring, confident", language: "en" },
  { id: "en-us-f-callie", label: "Callie", gender: "femenina", accent: "American", style: "Playful, friendly", language: "en" },
  { id: "en-us-f-matilda", label: "Matilda", gender: "femenina", accent: "American", style: "Knowledgeable, professional", language: "en" },
];
export const voicePreset = (id: string) => VOICE_PRESETS.find((v) => v.id === id) ?? null;

export type MusicMode = "inteligente" | "fija" | "sin_musica";
export const MUSIC_MOODS = ["calma", "reflexiva", "inspiradora", "intensa"] as const;
export type MusicMood = (typeof MUSIC_MOODS)[number];
export const MOOD_LABEL: Record<MusicMood, string> = { calma: "Calma", reflexiva: "Reflexiva", inspiradora: "Inspiradora", intensa: "Intensa" };
export type MusicConfig = { mode: MusicMode; mood: MusicMood; volume: number; ducking: boolean; intro: boolean; outro: boolean };
export const DEFAULT_MUSIC: MusicConfig = { mode: "inteligente", mood: "reflexiva", volume: 18, ducking: true, intro: true, outro: true };

export type ProjectStatus = "borrador" | "listo_para_autorizar";
export const STATUS_LABEL: Record<ProjectStatus, string> = { borrador: "Borrador", listo_para_autorizar: "Listo para autorizar" };

export type AudioProject = {
  id: string;
  ownerId: string;
  version: typeof MODULE_VERSION;
  title: string;
  language: StudioLanguage;
  voiceCount: 1 | 2;
  voices: string[];
  targetMinutes: number;
  script: string;
  notes: string;
  music: MusicConfig;
  budgetUsd: number;
  /** Modelo de voz elegido (Multilingual v2 por defecto). */
  ttsModel: TtsModelId;
  status: ProjectStatus;
  /** Gasto real registrado por el estudio (solo lo escribe el servidor tras una síntesis pagada). */
  spentUsd: number;
  /** Último MP3 terminado (lo escribe el worker). */
  audio: AudioResult | null;
  /** Estado de la generación (lo escribe el servidor). */
  generation: Generation;
  revision: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AudioResult = {
  path: string; bytes: number; sha256: string; durationSeconds: number; lufs: number; truePeak: number;
  revision: number; renderedAt: string; provider: string; model: TtsModelId; segments: number; reusedSegments: number; musicTracks: string[];
};
export type GenerationStatus = "inactiva" | "en_cola" | "generando" | "terminada" | "fallida";
export type Generation = {
  status: GenerationStatus;
  /** Autorización expresa: monto confirmado por la persona para la revisión indicada. */
  authorization: { usd: number; revision: number; at: string; spentBefore: number; model: TtsModelId } | null;
  kind: "generar" | "remezclar" | null;
  startedAt: string | null; heartbeatAt: string | null; finishedAt: string | null;
  progress: { done: number; total: number } | null;
  error: string | null;
  /** Llamadas al proveedor de voz y caracteres sintetizados en total (la caché evita repetirlas). */
  providerCalls: number; charsSynthesized: number;
};
export const IDLE_GENERATION: Generation = { status: "inactiva", authorization: null, kind: null, startedAt: null, heartbeatAt: null, finishedAt: null, progress: null, error: null, providerCalls: 0, charsSynthesized: 0 };
/** Sin latido durante este tiempo, una generación «en curso» se considera interrumpida y se puede reanudar. */
export const STALE_MS = 10 * 60_000;
export function generationActive(g: Generation, now: number): boolean {
  if (g.status !== "en_cola" && g.status !== "generando") return false;
  const beat = Date.parse(g.heartbeatAt ?? g.startedAt ?? "");
  return Number.isFinite(beat) ? now - beat < STALE_MS : false;
}
export const GENERATION_LABEL: Record<GenerationStatus, string> = { inactiva: "Sin generar", en_cola: "En cola", generando: "Generando", terminada: "Audio listo", fallida: "Falló" };

export type ProjectInput = Partial<Pick<AudioProject, "title" | "language" | "voiceCount" | "voices" | "targetMinutes" | "script" | "notes" | "music" | "budgetUsd" | "ttsModel">>;

export class ValidationError extends Error {
  constructor(readonly field: string, message: string) { super(message); this.name = "ValidationError"; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

const clampInt = (v: unknown, min: number, max: number, field: string): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new ValidationError(field, `«${field}» debe ser un número.`);
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** Quita caracteres de control (salvo saltos de línea y tabulaciones) y normaliza los finales de línea. */
export function cleanText(v: unknown, max: number, field: string): string {
  if (typeof v !== "string") throw new ValidationError(field, `«${field}» debe ser texto.`);
  const t = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (t.length > max) throw new ValidationError(field, `«${field}» supera el máximo de ${max.toLocaleString("es")} caracteres.`);
  return t;
}

function cleanMusic(v: unknown, prev: MusicConfig): MusicConfig {
  if (!v || typeof v !== "object") throw new ValidationError("music", "La configuración de música no es válida.");
  const m = v as Record<string, unknown>;
  const mode = m.mode ?? prev.mode;
  if (mode !== "inteligente" && mode !== "fija" && mode !== "sin_musica") throw new ValidationError("music", "Modo de música desconocido.");
  const mood = m.mood ?? prev.mood;
  if (!MUSIC_MOODS.includes(mood as MusicMood)) throw new ValidationError("music", "Ambiente musical desconocido.");
  const bool = (k: "ducking" | "intro" | "outro") => (m[k] === undefined ? prev[k] : m[k] === true);
  return { mode, mood: mood as MusicMood, volume: m.volume === undefined ? prev.volume : clampInt(m.volume, 0, 60, "volumen"), ducking: bool("ducking"), intro: bool("intro"), outro: bool("outro") };
}

function cleanVoices(count: 1 | 2, v: unknown): string[] {
  if (!Array.isArray(v)) throw new ValidationError("voices", "Elige las voces del episodio.");
  const ids = v.filter((x): x is string => typeof x === "string").slice(0, count);
  if (ids.length !== count) throw new ValidationError("voices", count === 1 ? "Elige una voz." : "Elige dos voces.");
  for (const id of ids) if (!voicePreset(id)) throw new ValidationError("voices", "Una de las voces elegidas no existe en el catálogo.");
  if (count === 2 && ids[0] === ids[1]) throw new ValidationError("voices", "Las dos voces deben ser distintas.");
  return ids;
}

/** Aplica una edición del cliente sobre un proyecto. Nunca acepta id, dueño, estado, gasto ni fechas del cliente. */
export function applyInput(prev: AudioProject, input: ProjectInput, now: string): AudioProject {
  if (!input || typeof input !== "object") throw new ValidationError("body", "Datos del proyecto no válidos.");
  const next: AudioProject = { ...prev, music: { ...prev.music }, voices: [...prev.voices] };
  if (input.language !== undefined) {
    if (input.language !== "es" && input.language !== "en") throw new ValidationError("language", "Elige español o inglés.");
    next.language = input.language;
  }
  if (input.title !== undefined) {
    const t = cleanText(input.title, MAX_TITLE, "título").replace(/\s+/g, " ").trim();
    if (!t) throw new ValidationError("title", "El episodio necesita un título.");
    next.title = t;
  }
  if (input.voiceCount !== undefined) {
    if (input.voiceCount !== 1 && input.voiceCount !== 2) throw new ValidationError("voiceCount", "El episodio admite una o dos voces.");
    next.voiceCount = input.voiceCount;
  }
  if (input.voices !== undefined || input.voiceCount !== undefined) {
    const wanted = input.voices ?? (next.voiceCount === 2 && next.voices.length === 1 ? [next.voices[0], defaultSecondVoice(next.voices[0], next.language)] : next.voices);
    next.voices = cleanVoices(next.voiceCount, wanted);
  }
  if (input.targetMinutes !== undefined) next.targetMinutes = clampInt(input.targetMinutes, MIN_TARGET_MINUTES, MAX_TARGET_MINUTES, "duración");
  if (input.script !== undefined) next.script = cleanText(input.script, MAX_SCRIPT, "guion");
  if (input.notes !== undefined) next.notes = cleanText(input.notes, MAX_NOTES, "notas");
  if (input.music !== undefined) next.music = cleanMusic(input.music, prev.music);
  if (input.ttsModel !== undefined) {
    if (!ttsModel(String(input.ttsModel))) throw new ValidationError("ttsModel", "Modelo de voz desconocido.");
    next.ttsModel = input.ttsModel;
  }
  if (input.budgetUsd !== undefined) {
    const b = typeof input.budgetUsd === "number" ? input.budgetUsd : Number(input.budgetUsd);
    if (!Number.isFinite(b) || b <= 0) throw new ValidationError("budgetUsd", "El tope de presupuesto debe ser mayor que cero.");
    next.budgetUsd = Math.min(MAX_BUDGET_USD, Math.round(b * 100) / 100);
  }
  // Cualquier cambio de contenido devuelve el proyecto a borrador: una autorización vale solo para lo que se revisó.
  if (next.status === "listo_para_autorizar" && contentChanged(prev, next)) next.status = "borrador";
  next.revision = prev.revision + 1;
  next.updatedAt = now;
  return next;
}

const contentChanged = (a: AudioProject, b: AudioProject) =>
  a.language !== b.language || a.ttsModel !== b.ttsModel ||
  a.title !== b.title || a.script !== b.script || a.voiceCount !== b.voiceCount || a.voices.join() !== b.voices.join() ||
  a.targetMinutes !== b.targetMinutes || JSON.stringify(a.music) !== JSON.stringify(b.music) || a.budgetUsd !== b.budgetUsd;

export function defaultSecondVoice(first: string, language: StudioLanguage = voicePreset(first)?.language ?? "es"): string {
  const g = voicePreset(first)?.gender;
  const voices = VOICE_PRESETS.filter((v) => v.language === language);
  return (voices.find((v) => v.id !== first && v.gender !== g) ?? voices.find((v) => v.id !== first))!.id;
}

export function newProject(args: { id: string; ownerId: string; now: string; title?: string; voiceCount?: 1 | 2; language?: StudioLanguage }): AudioProject {
  if (!isUuid(args.id) || !isUuid(args.ownerId)) throw new ValidationError("id", "Identificador no válido.");
  const base: AudioProject = {
    id: args.id, ownerId: args.ownerId, version: MODULE_VERSION, title: "Episodio sin título", language: "es", voiceCount: 1,
    voices: [VOICE_PRESETS[0].id], targetMinutes: 10, script: "", notes: "", music: { ...DEFAULT_MUSIC }, budgetUsd: DEFAULT_BUDGET_USD, ttsModel: DEFAULT_TTS_MODEL,
    status: "borrador", spentUsd: 0, audio: null, generation: { ...IDLE_GENERATION }, revision: 0, archivedAt: null, createdAt: args.now, updatedAt: args.now,
  };
  const language = args.language ?? "es";
  const first = VOICE_PRESETS.find(v => v.language === language)!.id;
  const voices = [first, defaultSecondVoice(first, language)].slice(0, args.voiceCount ?? 1);
  const p = applyInput(base, { title: args.title ?? base.title, language, voices, voiceCount: args.voiceCount ?? 1 }, args.now);
  return { ...p, revision: 1 };
}

/** Lee un proyecto guardado y descarta lo que no cumpla el esquema (nunca confía en el archivo). */
export function parseStored(raw: unknown, ownerId: string): AudioProject | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== MODULE_VERSION || !isUuid(r.id) || r.ownerId !== ownerId) return null;
  try {
    const base = newProject({ id: r.id, ownerId, now: typeof r.createdAt === "string" ? r.createdAt : new Date(0).toISOString() });
    const p = applyInput(base, {
      title: r.title as string, language: (r.language ?? "es") as StudioLanguage, voiceCount: r.voiceCount as 1 | 2, voices: r.voices as string[], targetMinutes: r.targetMinutes as number,
      script: r.script as string, notes: (r.notes as string) ?? "", music: r.music as MusicConfig, budgetUsd: r.budgetUsd as number, ttsModel: (ttsModel(String(r.ttsModel ?? "")) ? r.ttsModel : FALLBACK_TTS_MODEL) as TtsModelId,
    }, typeof r.updatedAt === "string" ? r.updatedAt : base.updatedAt);
    return {
      ...p,
      status: r.status === "listo_para_autorizar" ? "listo_para_autorizar" : "borrador",
      revision: typeof r.revision === "number" && Number.isInteger(r.revision) && r.revision > 0 ? r.revision : 1,
      archivedAt: typeof r.archivedAt === "string" ? r.archivedAt : null,
      createdAt: base.createdAt,
      spentUsd: typeof r.spentUsd === "number" && Number.isFinite(r.spentUsd) && r.spentUsd >= 0 ? r.spentUsd : 0,
      audio: parseAudio(r.audio),
      generation: parseGeneration(r.generation),
    };
  } catch {
    return null;
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

function parseAudio(v: unknown): AudioResult | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  const path = str(a.path), sha = str(a.sha256);
  if (!path || !/^audio-studio\/v1\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/audio\/[\w.-]+\.mp3$/.test(path) || !sha || !/^[0-9a-f]{64}$/.test(sha)) return null;
  return {
    path, sha256: sha, bytes: num(a.bytes) ?? 0, durationSeconds: num(a.durationSeconds) ?? 0, lufs: num(a.lufs) ?? 0, truePeak: num(a.truePeak) ?? 0,
    revision: num(a.revision) ?? 0, renderedAt: str(a.renderedAt) ?? "", provider: str(a.provider) ?? "", model: (ttsModel(String(a.model ?? "")) ? a.model : DEFAULT_TTS_MODEL) as TtsModelId, segments: num(a.segments) ?? 0,
    reusedSegments: num(a.reusedSegments) ?? 0, musicTracks: Array.isArray(a.musicTracks) ? a.musicTracks.filter((x): x is string => typeof x === "string") : [],
  };
}

function parseGeneration(v: unknown): Generation {
  if (!v || typeof v !== "object") return { ...IDLE_GENERATION };
  const g = v as Record<string, unknown>;
  const status = (["inactiva", "en_cola", "generando", "terminada", "fallida"] as const).find((x) => x === g.status) ?? "inactiva";
  const au = g.authorization as Record<string, unknown> | null | undefined;
  const pr = g.progress as Record<string, unknown> | null | undefined;
  return {
    status,
    authorization: au && num(au.usd) !== null && num(au.revision) !== null && str(au.at) ? { usd: num(au.usd)!, revision: num(au.revision)!, at: str(au.at)!, spentBefore: num(au.spentBefore) ?? 0, model: (ttsModel(String(au.model ?? "")) ? au.model : DEFAULT_TTS_MODEL) as TtsModelId } : null,
    kind: g.kind === "generar" || g.kind === "remezclar" ? g.kind : null,
    startedAt: str(g.startedAt), heartbeatAt: str(g.heartbeatAt), finishedAt: str(g.finishedAt),
    progress: pr && num(pr.done) !== null && num(pr.total) !== null ? { done: num(pr.done)!, total: num(pr.total)! } : null,
    error: str(g.error), providerCalls: num(g.providerCalls) ?? 0, charsSynthesized: num(g.charsSynthesized) ?? 0,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Guion, duración y costo

export type ScriptLine = { voice: 0 | 1; text: string; section: number };
const SPEAKER = /^\s*(?:(?:voz|voice)\s*([12])|\[([12])\])\s*[:\-—]\s*/i;

/** Divide el guion en intervenciones. Con dos voces, «Voz 1:» / «Voz 2:» (o «[1]:») cambian de voz. */
export function scriptLines(script: string, voiceCount: 1 | 2): ScriptLine[] {
  const out: ScriptLine[] = [];
  let voice: 0 | 1 = 0;
  // Índice de sección alineado con sections(): una sección cuenta solo si tiene texto narrable.
  let section = 0, sectionHasText = false;
  for (const raw of script.split(/\n\s*\n|\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (/^#{1,3}\s+/.test(line)) { if (sectionHasText) { section++; sectionHasText = false; } continue; }
    const m = SPEAKER.exec(line);
    if (m) {
      if (voiceCount === 2) voice = (m[1] ?? m[2]) === "2" ? 1 : 0;
      line = line.slice(m[0].length).trim();
    }
    if (line.startsWith("#")) continue; // títulos sin espacio: tampoco se narran
    if (line) { out.push({ voice: voiceCount === 2 ? voice : 0, text: line, section }); sectionHasText = true; }
  }
  return out;
}

export const wordCount = (s: string) => (s.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? []).length;

export type Estimate = {
  words: number; characters: number; estimatedMinutes: number; targetMinutes: number; durationGapMinutes: number;
  perVoiceCharacters: number[]; voiceUsdPer1kChars: number; estimatedUsd: number; budgetUsd: number; spentUsd: number;
  withinBudget: boolean; paidCallsEnabled: false;
};

export function voiceRate(env: Record<string, string | undefined> = process.env, model: TtsModelId = DEFAULT_TTS_MODEL): number {
  return modelRate(model, env).rate;
}

/** Rótulo único de la voz de demostración (solo la cuenta dueña): editor, biblioteca y tarifa. Seguro para el cliente. */
export const DEMO_VOICE_LABEL = "Voz de demostración — no es la voz final; USD 0";
/** Texto del proveedor del audio producido para la interfaz (fixture y demo nunca se confunden con la voz real). */
export function audioProviderNote(provider: string): string {
  return provider === "demo" ? ` · ${DEMO_VOICE_LABEL}` : provider === "fixture" ? " · voz de prueba local" : "";
}

export type ModelRate = { model: TtsModelId; rate: number; source: "produccion" | "verificada" | "conservadora" | "demo"; listUsdPer1k: number; note: string };
/**
 * Tarifa usada para estimar y para el tope de cada autorización.
 *  - Multilingual v2: PRICING_ELEVENLABS_USD_PER_1K_CHARS de producción (mínimo 0.20).
 *  - v4 Turbo: solo con AUDIO_STUDIO_RATE_ELEVEN_V4_TURBO (tarifa efectiva comprobada en la cuenta) se usa una tarifa
 *    propia, y nunca menor que la de lista. Sin ella se estima con la tarifa de v2: no se asume un descuento no comprobado.
 */
export function modelRate(model: TtsModelId, env: Record<string, string | undefined> = process.env): ModelRate {
  const n = Number(env.PRICING_ELEVENLABS_USD_PER_1K_CHARS);
  const v2 = Number.isFinite(n) && n > 0 ? Math.max(n, DEFAULT_VOICE_USD_PER_1K_CHARS) : DEFAULT_VOICE_USD_PER_1K_CHARS;
  const m = ttsModel(model) ?? ttsModel(DEFAULT_TTS_MODEL)!;
  if (m.id === "eleven_multilingual_v2") return { model: m.id, rate: v2, source: "produccion", listUsdPer1k: m.listUsdPer1k, note: "Tarifa efectiva configurada en producción." };
  const verified = Number(env.AUDIO_STUDIO_RATE_ELEVEN_V4_TURBO);
  if (Number.isFinite(verified) && verified > 0) {
    return { model: m.id, rate: Math.max(verified, m.listUsdPer1k), source: "verificada", listUsdPer1k: m.listUsdPer1k, note: "Tarifa efectiva comprobada en la cuenta." };
  }
  return { model: m.id, rate: v2, source: "conservadora", listUsdPer1k: m.listUsdPer1k,
    note: `Tarifa de la cuenta sin verificar: se estima igual que Multilingual v2 (USD ${v2.toFixed(2)}/1K). La de lista es USD ${m.listUsdPer1k.toFixed(2)}/1K.` };
}

export function estimate(p: Pick<AudioProject, "script" | "voiceCount" | "targetMinutes" | "budgetUsd" | "spentUsd">, rate = DEFAULT_VOICE_USD_PER_1K_CHARS): Estimate {
  const lines = scriptLines(p.script, p.voiceCount);
  const perVoice = [0, 0];
  for (const l of lines) perVoice[l.voice] += l.text.length;
  const characters = perVoice[0] + perVoice[1];
  const words = lines.reduce((n, l) => n + wordCount(l.text), 0);
  const estimatedMinutes = Math.round((words / WORDS_PER_MINUTE) * 10) / 10;
  const estimatedUsd = Math.ceil((characters / 1000) * rate * 100) / 100;
  return {
    words, characters, estimatedMinutes, targetMinutes: p.targetMinutes, durationGapMinutes: Math.round((estimatedMinutes - p.targetMinutes) * 10) / 10,
    perVoiceCharacters: perVoice.slice(0, p.voiceCount), voiceUsdPer1kChars: rate, estimatedUsd, budgetUsd: p.budgetUsd, spentUsd: p.spentUsd,
    withinBudget: estimatedUsd <= p.budgetUsd, paidCallsEnabled: false,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Música inteligente: un ambiente por sección según el texto (determinista, sin IA ni red)

const MOOD_WORDS: Record<MusicMood, RegExp> = {
  calma: /\b(calma|silencio|respira|respirar|paz|sereno|serenidad|quietud|descanso|aceptar|aceptación)\w*/giu,
  reflexiva: /\b(piensa|pensar|recuerda|pregunta|reflexi|memoria|tiempo|muerte|pasado|entender|comprend)\w*/giu,
  inspiradora: /\b(puedes|futuro|libertad|libre|fuerza|valor|camino|empieza|comienza|elige|decide|crecer|virtud)\w*/giu,
  intensa: /\b(miedo|ira|rabia|caos|pérdida|crisis|dolor|golpe|tormenta|ansiedad|angustia)\w*/giu,
};

export type MusicSection = { index: number; heading: string; mood: MusicMood };

export function sections(script: string): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = [];
  let cur = { heading: "Inicio", text: "" };
  for (const line of script.split("\n")) {
    const h = /^\s*#{1,3}\s+(.+)$/.exec(line);
    if (h) {
      if (cur.text.trim()) out.push(cur);
      cur = { heading: h[1].trim(), text: "" };
    } else cur.text += line + "\n";
  }
  if (cur.text.trim()) out.push(cur);
  return out;
}

export function musicPlan(script: string, music: MusicConfig): MusicSection[] {
  if (music.mode === "sin_musica") return [];
  return sections(script).map((s, index) => {
    if (music.mode === "fija") return { index, heading: s.heading, mood: music.mood };
    let best: MusicMood = music.mood, score = 0;
    for (const mood of MUSIC_MOODS) {
      const n = (s.text.match(MOOD_WORDS[mood]) ?? []).length;
      if (n > score) { best = mood; score = n; }
    }
    return { index, heading: s.heading, mood: best };
  });
}

/** Qué falta para que el proyecto pueda pasar a «listo para autorizar». Vacío = listo. */
export function readinessIssues(p: AudioProject, e: Estimate): string[] {
  const issues: string[] = [];
  const limit = ttsModel(p.ttsModel)?.maxCharsPerRequest ?? 10_000;
  if (scriptLines(p.script, p.voiceCount).some((l) => l.text.length > limit)) issues.push(`Una intervención supera ${limit.toLocaleString("es")} caracteres (límite por solicitud del modelo): divídela en párrafos.`);
  if (p.voices.some(id => voicePreset(id)?.language !== p.language)) issues.push("Elige voces del idioma seleccionado.");
  if (!p.title.trim()) issues.push("Falta el título.");
  if (e.words < 50) issues.push("El guion es demasiado corto (menos de 50 palabras).");
  if (p.voiceCount === 2 && e.perVoiceCharacters[1] === 0) issues.push("Con dos voces, marca las intervenciones de la segunda con «Voz 2:».");
  if (!e.withinBudget) issues.push(`El costo estimado (USD ${e.estimatedUsd.toFixed(2)}) supera el tope (USD ${p.budgetUsd.toFixed(2)}).`);
  if (Math.abs(e.durationGapMinutes) > Math.max(2, p.targetMinutes * 0.2)) issues.push(`La duración estimada (${e.estimatedMinutes} min) se aleja del objetivo (${p.targetMinutes} min).`);
  return issues;
}

/**
 * Estructura inicial de guion (sin IA ni costo): secciones con pautas que la persona reemplaza por su texto.
 * Con dos voces alterna «Voz 1:» y «Voz 2:». La cantidad de secciones crece con la duración objetivo.
 */
export function draftOutline(title: string, minutes: number, voiceCount: 1 | 2, language: StudioLanguage = "es"): string {
  if (language === "en") {
    return ["Opening", "Main idea", "Conclusion"].map((heading, i) => `## ${heading}\n\n${voiceCount === 2 ? "Voice 1: " : ""}${i === 0 ? `Introduce ${title}.` : i === 2 ? "Summarize the key idea and suggest one practical action." : "Develop the idea with an everyday example."} Replace this outline with your English script.${voiceCount === 2 ? "\n\nVoice 2: Add a question or another perspective." : ""}`).join("\n\n");
  }
  const n = Math.min(12, Math.max(3, Math.round(minutes / 3)));
  const middle = Array.from({ length: n - 2 }, (_, i) => `Idea ${i + 1}`);
  const heads = ["Apertura", ...middle, "Cierre"];
  const wordsPer = Math.round((minutes * WORDS_PER_MINUTE) / heads.length);
  const v = (k: number) => (voiceCount === 2 ? `Voz ${(k % 2) + 1}: ` : "");
  return heads.map((h, i) => {
    const cue = i === 0 ? `Presenta «${title.trim() || "el episodio"}» y cuenta por qué importa hoy.`
      : i === heads.length - 1 ? "Resume lo esencial y deja una acción concreta para quien escucha."
      : "Desarrolla esta idea con un ejemplo cotidiano.";
    return `## ${h}\n\n${v(0)}${cue} (Reemplaza esta pauta por unas ${wordsPer} palabras.)${voiceCount === 2 ? `\n\n${v(1)}Responde, pregunta o añade un matiz.` : ""}`;
  }).join("\n\n");
}
