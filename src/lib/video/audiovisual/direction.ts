/**
 * Resolución de la dirección audiovisual VERSIONADA, ligada al guion
 * aprobado. Se calcula al iniciar la producción (aprobación del guion) y se
 * guarda en video_requests.audiovisual_direction; los reintentos la
 * reutilizan mientras la huella (fingerprint) coincida. Editar el guion, el
 * tema, el tono o la selección cambia la huella → la dirección anterior
 * deja de valer y los recursos que dependían de ella (imágenes con estilo)
 * se regeneran bajo otra ruta en vez de reutilizarse.
 *
 * Prioridad de la intención (docs/AUDIOVISUAL_DIRECTION.md):
 *  1. Ajuste explícito del cliente.
 *  2. Perfil completo (Horror y misterio → suspenso).
 *  3. Tono fuerte elegido en el formulario (terror, humor, motivacional).
 *  4. Intención del GUION COMPLETO (densidad y reparto entre escenas;
 *     palabras aisladas nunca bastan).
 *  5. Tono débil del formulario (educativo, curiosidades…) y, por último,
 *     divulgativo.
 * La energía de cada escena solo modula el montaje dentro de esa intención.
 *
 * Contrato reutilizable: nada aquí depende de Reel; `format` deja listo el
 * punto donde Long Form añadirá sus propios ritmos de documental.
 */
import { createHash } from "node:crypto";
import {
  INTENTS,
  PROFILES,
  STRONG_STYLE_INTENT,
  WEAK_STYLE_INTENT,
  isAudiovisualSelection,
  summarizeDirection,
  type AudiovisualSelection,
  type IntentId,
  type MusicChoice,
  type PaceId,
  type ProfileId,
} from "./catalog";

export const AUDIOVISUAL_DIRECTION_VERSION = 1;

export type SceneEnergy = "low" | "medium" | "high";
export type DirectionFormat = "reel";

export type IntentSource = "override" | "profile" | "style" | "script" | "style_weak" | "default";

export type DirectionScene = { text: string; energy?: string | null };

export type AudiovisualDirection = {
  version: typeof AUDIOVISUAL_DIRECTION_VERSION;
  format: DirectionFormat;
  /** Huella de todo lo que determina la dirección (selección + tono + tema + guion). */
  fingerprint: string;
  resolvedAt: string;
  selection: AudiovisualSelection;
  profile: ProfileId;
  intent: { id: IntentId; source: IntentSource; evidence?: ScriptIntentEvidence };
  music: { id: MusicChoice; source: "override" | "intent" };
  pace: { id: PaceId; source: "override" | "intent" };
  /** Energía por escena del guion aprobado (del propio guion; "medium" si no la trae). */
  sceneEnergy: SceneEnergy[];
  summary: string;
};

export type ScriptIntentEvidence = {
  intent: IntentId;
  hits: number;
  distinctTerms: number;
  scenesWithHits: number;
  per100Words: number;
  runnerUp?: { intent: IntentId; hits: number };
};

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Léxico por intención (es/en, sin tildes). Entradas de ≥5 letras actúan
 * como raíz (asesin → asesino, asesinato); las cortas exigen palabra exacta;
 * las que tienen espacio, frase exacta.
 */
const INTENT_LEXICON: Record<IntentId, string[]> = {
  suspense: [
    "miedo", "terror", "oscur", "misteri", "sombra", "grito", "gritos", "desapareci", "extrano", "extrana", "inquietant", "escalofri",
    "fantasma", "maldit", "sangre", "muerte", "muerto", "muertos", "crimen", "asesin", "peligro", "horror", "amenaza", "secreto",
    "abandonad", "nadie sabe", "nunca volvio", "susurro", "pesadilla", "cadaver", "encerrad", "sospech",
    "fear", "scream", "vanish", "ghost", "blood", "murder", "creepy", "eerie", "haunted", "nightmare", "mystery", "danger",
  ],
  humor: [
    "risa", "risas", "gracios", "chiste", "ridicul", "absurd", "torpe", "carcajada", "divertid", "broma", "jaja", "meme", "ironi",
    "funny", "joke", "laugh", "hilarious", "silly", "awkward",
  ],
  uplifting: [
    "lograr", "logro", "meta", "metas", "sueno", "suenos", "superar", "disciplina", "motivaci", "inspira", "exito", "triunf",
    "crecer", "tu puedes", "nunca te rindas", "esfuerzo", "achieve", "success", "overcome", "dream", "goal",
  ],
  informative: [
    "dato", "datos", "sabias", "cientific", "estudio", "investigaci", "porcentaje", "descubri", "funciona", "explica", "segun",
    "fact", "facts", "study", "research", "scientist", "percent",
  ],
  reflective: [
    "recuerdo", "recuerdos", "nostalgi", "amor", "perdida", "gratitud", "familia", "extrano a", "abrazo", "lagrima", "soledad",
    "memory", "grateful", "lonely", "love",
  ],
  action: [
    "carrera", "persecuci", "explosi", "velocidad", "lucha", "batalla", "ataque", "escape", "adrenalina", "choque", "disparo",
    "chase", "explosion", "speed", "fight", "battle", "attack",
  ],
};

function matches(tokens: string[], text: string, entry: string): number {
  if (entry.includes(" ")) {
    let count = 0;
    let from = 0;
    const needle = ` ${entry} `;
    const hay = ` ${text} `;
    for (;;) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      count += 1;
      from = i + needle.length - 1;
    }
    return count;
  }
  return tokens.filter((t) => (entry.length >= 5 ? t.startsWith(entry) : t === entry)).length;
}

/** Umbrales: una intención del guion solo cuenta si domina el texto completo, no por palabras aisladas. */
export const SCRIPT_INTENT_THRESHOLDS = { minHits: 3, minDistinct: 2, minScenes: 2, minPer100Words: 2, dominance: 1.5 };

export function analyzeScriptIntent(scenes: DirectionScene[]): ScriptIntentEvidence | null {
  const perScene = scenes.map((s) => {
    const text = normalize(s.text);
    return { text, tokens: text.split(" ").filter(Boolean) };
  });
  const totalWords = perScene.reduce((n, s) => n + s.tokens.length, 0);
  if (totalWords === 0) return null;

  const scored = (Object.keys(INTENT_LEXICON) as IntentId[]).map((intent) => {
    let hits = 0;
    const distinct = new Set<string>();
    let scenesWithHits = 0;
    for (const scene of perScene) {
      let sceneHits = 0;
      for (const entry of INTENT_LEXICON[intent]) {
        const n = matches(scene.tokens, scene.text, entry);
        if (n > 0) {
          sceneHits += n;
          distinct.add(entry);
        }
      }
      hits += sceneHits;
      if (sceneHits > 0) scenesWithHits += 1;
    }
    return { intent, hits, distinctTerms: distinct.size, scenesWithHits, per100Words: (hits * 100) / totalWords };
  });
  scored.sort((a, b) => b.hits - a.hits);
  const [top, second] = scored;
  const t = SCRIPT_INTENT_THRESHOLDS;
  const minScenes = Math.min(t.minScenes, scenes.length);
  const dominant = !second || second.hits === 0 || top.hits >= second.hits * t.dominance;
  if (top.hits < t.minHits || top.distinctTerms < t.minDistinct || top.scenesWithHits < minScenes || top.per100Words < t.minPer100Words || !dominant) {
    return null;
  }
  return {
    ...top,
    per100Words: Math.round(top.per100Words * 100) / 100,
    ...(second && second.hits > 0 ? { runnerUp: { intent: second.intent, hits: second.hits } } : {}),
  };
}

export function resolveIntent(input: {
  selection: AudiovisualSelection;
  style?: string;
  scenes: DirectionScene[];
}): AudiovisualDirection["intent"] {
  const { selection } = input;
  if (selection.intent) return { id: selection.intent, source: "override" };
  const preset = PROFILES[selection.profile].intentPreset;
  if (preset) return { id: preset, source: "profile" };
  const style = input.style?.trim().toLowerCase() ?? "";
  const strong = STRONG_STYLE_INTENT[style];
  if (strong) return { id: strong, source: "style" };
  const evidence = analyzeScriptIntent(input.scenes);
  if (evidence) return { id: evidence.intent, source: "script", evidence };
  const weak = WEAK_STYLE_INTENT[style];
  if (weak) return { id: weak, source: "style_weak" };
  return { id: "informative", source: "default" };
}

function sceneEnergyOf(raw: string | null | undefined): SceneEnergy {
  return raw === "low" || raw === "high" ? raw : "medium";
}

export function directionFingerprint(input: {
  selection: AudiovisualSelection;
  style?: string;
  topic?: string;
  scenes: DirectionScene[];
  format?: DirectionFormat;
}): string {
  const payload = JSON.stringify({
    v: AUDIOVISUAL_DIRECTION_VERSION,
    format: input.format ?? "reel",
    selection: { profile: input.selection.profile, intent: input.selection.intent ?? null, music: input.selection.music ?? null, pace: input.selection.pace ?? null },
    style: input.style?.trim() ?? "",
    topic: input.topic?.trim() ?? "",
    scenes: input.scenes.map((s) => [s.text, s.energy ?? null]),
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function resolveDirection(input: {
  selection: AudiovisualSelection;
  style?: string;
  topic?: string;
  scenes: DirectionScene[];
  format?: DirectionFormat;
  now?: Date;
}): AudiovisualDirection {
  const intent = resolveIntent(input);
  const music = input.selection.music
    ? { id: input.selection.music, source: "override" as const }
    : { id: INTENTS[intent.id].defaultMusic as MusicChoice, source: "intent" as const };
  const pace = input.selection.pace
    ? { id: input.selection.pace, source: "override" as const }
    : { id: INTENTS[intent.id].defaultPace, source: "intent" as const };
  return {
    version: AUDIOVISUAL_DIRECTION_VERSION,
    format: input.format ?? "reel",
    fingerprint: directionFingerprint(input),
    resolvedAt: (input.now ?? new Date()).toISOString(),
    selection: input.selection,
    profile: input.selection.profile,
    intent,
    music,
    pace,
    sceneEnergy: input.scenes.map((s) => sceneEnergyOf(s.energy)),
    summary: summarizeDirection({ intent: intent.id, music: music.id, pace: pace.id }),
  };
}

export function isAudiovisualDirection(value: unknown): value is AudiovisualDirection {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<AudiovisualDirection>;
  return (
    v.version === AUDIOVISUAL_DIRECTION_VERSION &&
    typeof v.fingerprint === "string" &&
    isAudiovisualSelection(v.selection) &&
    typeof v.profile === "string" && v.profile in PROFILES &&
    typeof v.intent?.id === "string" && v.intent.id in INTENTS &&
    Array.isArray(v.sceneEnergy)
  );
}

/**
 * Reutiliza la dirección guardada si sigue correspondiendo EXACTAMENTE a
 * la selección, tono, tema y guion actuales (reintentos); si no, resuelve
 * una nueva. `reused` sirve para auditoría/logs.
 */
export function directionForApprovedScript(input: {
  stored: unknown;
  selection: AudiovisualSelection;
  style?: string;
  topic?: string;
  scenes: DirectionScene[];
  now?: Date;
}): { direction: AudiovisualDirection; reused: boolean } {
  const fingerprint = directionFingerprint(input);
  if (isAudiovisualDirection(input.stored) && input.stored.fingerprint === fingerprint) {
    return { direction: input.stored, reused: true };
  }
  return { direction: resolveDirection(input), reused: false };
}

/** Defensa en profundidad del worker: la dirección guardada debe corresponder al guion que se va a producir. */
export function assertDirectionMatches(input: {
  stored: unknown;
  selection: AudiovisualSelection;
  style?: string;
  topic?: string;
  scenes: DirectionScene[];
}): AudiovisualDirection {
  if (!isAudiovisualDirection(input.stored)) {
    throw new DirectionMismatchError("Falta la dirección audiovisual aprobada para este guion. Vuelve a iniciar la producción desde la revisión del guion.");
  }
  if (input.stored.fingerprint !== directionFingerprint(input)) {
    throw new DirectionMismatchError("El guion o la dirección cambiaron después de aprobarse. Vuelve a iniciar la producción desde la revisión del guion.");
  }
  return input.stored;
}

export class DirectionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectionMismatchError";
  }
}
