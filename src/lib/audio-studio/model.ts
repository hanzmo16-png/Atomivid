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
export const MIN_TARGET_MINUTES = 1;
export const MAX_TARGET_MINUTES = 60;
/** Ritmo de narración en español usado para estimar la duración (palabras por minuto). */
export const WORDS_PER_MINUTE = 150;
/** Tarifa de voz por 1 000 caracteres. 0.20 es la tarifa configurada en producción (la más conservadora conocida). */
export const DEFAULT_VOICE_USD_PER_1K_CHARS = 0.2;
export const DEFAULT_BUDGET_USD = 6;
export const MAX_BUDGET_USD = 20;

export type VoiceGender = "masculina" | "femenina";
export type VoicePreset = { id: string; label: string; gender: VoiceGender; accent: string; style: string };

/**
 * Perfiles de voz del estudio. Son perfiles, no voces del proveedor: la voz concreta de ElevenLabs se confirma al
 * autorizar la primera generación real (consultar el catálogo del proveedor no forma parte de 1.0).
 */
export const VOICE_PRESETS: readonly VoicePreset[] = [
  { id: "es-latam-m-profesional", label: "Mateo — masculina profesional", gender: "masculina", accent: "Español latinoamericano", style: "Grave, pausada, de locutor" },
  { id: "es-latam-m-calida", label: "Andrés — masculina cálida", gender: "masculina", accent: "Español latinoamericano", style: "Cercana, conversacional" },
  { id: "es-latam-f-profesional", label: "Lucía — femenina profesional", gender: "femenina", accent: "Español latinoamericano", style: "Clara, serena, de locutora" },
  { id: "es-latam-f-energica", label: "Sofía — femenina enérgica", gender: "femenina", accent: "Español latinoamericano", style: "Dinámica, expresiva" },
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
  language: "es";
  voiceCount: 1 | 2;
  voices: string[];
  targetMinutes: number;
  script: string;
  notes: string;
  music: MusicConfig;
  budgetUsd: number;
  status: ProjectStatus;
  /** Gasto real registrado por el estudio. En 1.0 nunca cambia: no hay llamadas pagadas. */
  spentUsd: 0;
  audio: null;
  revision: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectInput = Partial<Pick<AudioProject, "title" | "voiceCount" | "voices" | "targetMinutes" | "script" | "notes" | "music" | "budgetUsd">>;

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
    const wanted = input.voices ?? (next.voiceCount === 2 && next.voices.length === 1 ? [next.voices[0], defaultSecondVoice(next.voices[0])] : next.voices);
    next.voices = cleanVoices(next.voiceCount, wanted);
  }
  if (input.targetMinutes !== undefined) next.targetMinutes = clampInt(input.targetMinutes, MIN_TARGET_MINUTES, MAX_TARGET_MINUTES, "duración");
  if (input.script !== undefined) next.script = cleanText(input.script, MAX_SCRIPT, "guion");
  if (input.notes !== undefined) next.notes = cleanText(input.notes, MAX_NOTES, "notas");
  if (input.music !== undefined) next.music = cleanMusic(input.music, prev.music);
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
  a.title !== b.title || a.script !== b.script || a.voiceCount !== b.voiceCount || a.voices.join() !== b.voices.join() ||
  a.targetMinutes !== b.targetMinutes || JSON.stringify(a.music) !== JSON.stringify(b.music) || a.budgetUsd !== b.budgetUsd;

export function defaultSecondVoice(first: string): string {
  const g = voicePreset(first)?.gender;
  return (VOICE_PRESETS.find((v) => v.id !== first && v.gender !== g) ?? VOICE_PRESETS.find((v) => v.id !== first))!.id;
}

export function newProject(args: { id: string; ownerId: string; now: string; title?: string; voiceCount?: 1 | 2 }): AudioProject {
  if (!isUuid(args.id) || !isUuid(args.ownerId)) throw new ValidationError("id", "Identificador no válido.");
  const base: AudioProject = {
    id: args.id, ownerId: args.ownerId, version: MODULE_VERSION, title: "Episodio sin título", language: "es", voiceCount: 1,
    voices: [VOICE_PRESETS[0].id], targetMinutes: 10, script: "", notes: "", music: { ...DEFAULT_MUSIC }, budgetUsd: DEFAULT_BUDGET_USD,
    status: "borrador", spentUsd: 0, audio: null, revision: 0, archivedAt: null, createdAt: args.now, updatedAt: args.now,
  };
  const p = applyInput(base, { title: args.title ?? base.title, voiceCount: args.voiceCount ?? 1 }, args.now);
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
      title: r.title as string, voiceCount: r.voiceCount as 1 | 2, voices: r.voices as string[], targetMinutes: r.targetMinutes as number,
      script: r.script as string, notes: (r.notes as string) ?? "", music: r.music as MusicConfig, budgetUsd: r.budgetUsd as number,
    }, typeof r.updatedAt === "string" ? r.updatedAt : base.updatedAt);
    return {
      ...p,
      status: r.status === "listo_para_autorizar" ? "listo_para_autorizar" : "borrador",
      revision: typeof r.revision === "number" && Number.isInteger(r.revision) && r.revision > 0 ? r.revision : 1,
      archivedAt: typeof r.archivedAt === "string" ? r.archivedAt : null,
      createdAt: base.createdAt,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Guion, duración y costo

export type ScriptLine = { voice: 0 | 1; text: string };
const SPEAKER = /^\s*(?:voz\s*([12])|\[([12])\])\s*[:\-—]\s*/i;

/** Divide el guion en intervenciones. Con dos voces, «Voz 1:» / «Voz 2:» (o «[1]:») cambian de voz. */
export function scriptLines(script: string, voiceCount: 1 | 2): ScriptLine[] {
  const out: ScriptLine[] = [];
  let voice: 0 | 1 = 0;
  for (const raw of script.split(/\n\s*\n|\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const m = SPEAKER.exec(line);
    if (m) {
      if (voiceCount === 2) voice = (m[1] ?? m[2]) === "2" ? 1 : 0;
      line = line.slice(m[0].length).trim();
    }
    if (line.startsWith("#")) continue; // títulos de sección: no se narran
    if (line) out.push({ voice: voiceCount === 2 ? voice : 0, text: line });
  }
  return out;
}

export const wordCount = (s: string) => (s.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? []).length;

export type Estimate = {
  words: number; characters: number; estimatedMinutes: number; targetMinutes: number; durationGapMinutes: number;
  perVoiceCharacters: number[]; voiceUsdPer1kChars: number; estimatedUsd: number; budgetUsd: number; spentUsd: number;
  withinBudget: boolean; paidCallsEnabled: false;
};

export function voiceRate(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.PRICING_ELEVENLABS_USD_PER_1K_CHARS);
  // Nunca por debajo de la tarifa de producción conocida: el estimado no debe quedarse corto.
  return Number.isFinite(n) && n > 0 ? Math.max(n, DEFAULT_VOICE_USD_PER_1K_CHARS) : DEFAULT_VOICE_USD_PER_1K_CHARS;
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
  if (!p.title.trim()) issues.push("Falta el título.");
  if (e.words < 50) issues.push("El guion es demasiado corto (menos de 50 palabras).");
  if (p.voiceCount === 2 && e.perVoiceCharacters[1] === 0) issues.push("Con dos voces, marca las intervenciones de la segunda con «Voz 2:».");
  if (!e.withinBudget) issues.push(`El costo estimado (USD ${e.estimatedUsd.toFixed(2)}) supera el tope (USD ${p.budgetUsd.toFixed(2)}).`);
  if (Math.abs(e.durationGapMinutes) > Math.max(2, p.targetMinutes * 0.2)) issues.push(`La duración estimada (${e.estimatedMinutes} min) se aleja del objetivo (${p.targetMinutes} min).`);
  return issues;
}
