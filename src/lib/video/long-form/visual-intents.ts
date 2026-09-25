/**
 * Intención visual REAL por shot para la ruta de producto de Long Form.
 * Antes de esto, shotsForSpan() rellenaba visualIntent con
 * "<shotType> for <beatType>" (p. ej. "generated_placeholder for hook") —
 * texto de fixture que en modo real se habría enviado tal cual como
 * búsqueda a Pexels y como prompt pagado a OpenAI.
 *
 * Fuente preferida: `visuals` que el guionista (Claude) declara por beat
 * en inglés al generar el guion (ver documentary-script.ts). Guiones sin
 * ese campo (creados antes) derivan descripciones del tema + palabras
 * clave de la narración — sin red, sin costo, nunca contenido inventado.
 */
import type { TextCardSpec } from "./diagram-map";

export type BeatVisual = {
  /** Escena concreta y filmable, idealmente en inglés (búsqueda de stock y prompt de imagen/video). */
  description: string;
  /** true si la escena depende de una acción/movimiento que una imagen fija perdería (insumo del eligibility de video IA). */
  motion: boolean;
  // --- Anclaje y pertinencia (calidad visual M1, todos opcionales: guiones
  // anteriores no los traen y siguen funcionando) ---
  /** Cita LITERAL (en el idioma de la narración) del pasaje que esta escena ilustra — ancla la intención a su momento exacto. */
  quote?: string;
  /** Sujeto principal visible (en inglés), p. ej. "steam shovel". */
  subject?: string;
  /** Acción visible (en inglés), p. ej. "digging". */
  action?: string;
  /** Lugar (en inglés), p. ej. "Panama". */
  place?: string;
  /** Época (texto libre o año), p. ej. "1910s" — contexto histórico que el material NO debe contradecir. */
  era?: string;
  /** Búsquedas alternativas (en inglés) del MISMO contenido — amplían candidatos sin cambiar de tema. */
  alternates?: string[];
  /** true si NO la declaró el guionista (derivada de palabras de la narración): su pertinencia no se puede comprobar contra el texto del proveedor. */
  derived?: boolean;
};

const MAX_VISUALS_PER_BEAT = 16;
const MAX_FIELD_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 180;

const STOPWORDS = new Set(
  (
    "a al algo algunas algunos ante antes aquel aquella aquello aqui aquí asi así aun aún cada casi como cómo con contra cual cuál cuando cuándo de del desde donde dónde dos el él ella ellas ellos en entre era eran es esa esas ese eso esos esta está estaba estaban estas este esto estos fue fueron gran grande ha había habían han hasta hay la las le les lo los mas más me mientras mismo muy nada ni no nos nosotros o otra otras otro otros para pero poco por porque puede pueden que qué quien quién se sea ser si sí sido sin sobre solo sólo son su sus también tan tanto te tenía tiene tienen todo todos tras tu un una uno unos y ya " +
    "the of and to in is was were that this with for as on by from at are be it its an or which their they them these those than then there into over under about after before between during"
  ).split(" "),
);

function cleanDescription(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_CHARS);
}

/** Normaliza `beat.visuals` del guion (datos externos: se validan, nunca se confía en su forma). */
export function normalizeDeclaredVisuals(value: unknown): BeatVisual[] {
  if (!Array.isArray(value)) return [];
  const out: BeatVisual[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const description = (item as { description?: unknown }).description;
    if (typeof description !== "string" || !description.trim()) continue;
    const field = (key: string): string | undefined => {
      const v = (item as Record<string, unknown>)[key];
      return typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, key === "quote" ? MAX_DESCRIPTION_CHARS : MAX_FIELD_CHARS) : undefined;
    };
    const rawAlternates = (item as { alternates?: unknown }).alternates;
    const alternates = Array.isArray(rawAlternates)
      ? rawAlternates.filter((a): a is string => typeof a === "string" && a.trim().length > 0).map(cleanDescription).slice(0, 3)
      : undefined;
    const visual: BeatVisual = { description: cleanDescription(description), motion: (item as { motion?: unknown }).motion === true };
    for (const key of ["quote", "subject", "action", "place", "era"] as const) {
      const v = field(key);
      if (v) visual[key] = v;
    }
    if (alternates && alternates.length > 0) visual.alternates = alternates;
    out.push(visual);
    if (out.length >= MAX_VISUALS_PER_BEAT) break;
  }
  return out;
}

export function splitSentences(text: string): string[] {
  return (text.match(/[^.!?…]+[.!?…]*/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
}

function keywords(sentence: string, limit: number): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of sentence.split(/[^\p{L}\p{N}-]+/u)) {
    const word = raw.trim();
    const lower = word.toLowerCase();
    if (word.length < 5 || STOPWORDS.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    words.push(word);
    if (words.length >= limit) break;
  }
  return words;
}

/** Descripciones derivadas (sin `visuals` declarados): tema + palabras clave de cada oración — nunca un placeholder. */
export function deriveVisualsFromNarration(topic: string, narration: string): BeatVisual[] {
  const cleanTopic = cleanDescription(topic);
  const derived: BeatVisual[] = [];
  for (const sentence of splitSentences(narration)) {
    const kw = keywords(sentence, 4);
    if (kw.length === 0) continue;
    derived.push({ description: cleanDescription(`${cleanTopic} ${kw.join(" ")}`), motion: false, derived: true });
    if (derived.length >= 4) break;
  }
  return derived.length > 0 ? derived : [{ description: cleanTopic, motion: false, derived: true }];
}

export function visualsForBeat(beat: { narration: string; visuals?: unknown }, topic: string): BeatVisual[] {
  const declared = normalizeDeclaredVisuals(beat.visuals);
  return declared.length > 0 ? declared : deriveVisualsFromNarration(topic, beat.narration);
}

/** Prompt de imagen fija documental (OpenAI Images) a partir de una intención real. */
export function documentaryImagePrompt(visualIntent: string): string {
  return (
    `Photorealistic documentary still, natural lighting, cinematic 16:9 composition: ${visualIntent}. ` +
    "No text, no captions, no logos, no watermarks."
  );
}

/** Índice (0-based) del shot dentro de su beat, a partir del id determinístico "<beatId>-shot-<n>". */
export function shotIndexInBeat(shotId: string): number {
  const match = /-shot-(\d+)$/.exec(shotId);
  return match ? Math.max(0, Number(match[1]) - 1) : 0;
}

/** Tarjeta de texto REAL (tema + una oración de la propia narración) — reemplaza a buildFixtureTextCardSpec en producción. */
export function textCardForShot(shot: { id: string; captionText: string }, topic: string): TextCardSpec {
  const sentences = splitSentences(shot.captionText);
  const sentence = sentences.length > 0 ? sentences[shotIndexInBeat(shot.id) % sentences.length] : shot.captionText;
  const body = sentence.length > 160 ? `${sentence.slice(0, 157).trimEnd()}…` : sentence;
  return { kind: "text", title: cleanDescription(topic), body, isFixture: false };
}
