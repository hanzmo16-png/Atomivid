/**
 * Anclaje escena ↔ narración (Long Form, calidad visual M1).
 *
 * Causa raíz confirmada en la revisión del Canal de Panamá: shotsForSpan()
 * asignaba `visuals[i % visuals.length]` — con 2-4 descripciones por beat y
 * 13-17 escenas por beat, cada descripción se reciclaba 4-7 veces sin
 * relación con lo que se estaba narrando en ese momento, y todas las
 * escenas llevaban como `captionText` la narración COMPLETA del beat.
 *
 * Aquí, cada escena recibe:
 * - `narrationFragment`: lo que se narra DURANTE esa escena (con los
 *   tiempos reales por palabra de la síntesis; en el plan, estimado por
 *   posición de palabra).
 * - Una intención visual ANCLADA: la descripción declarada cuyo tramo de
 *   narración contiene a la escena (por la cita que el guionista declara, o
 *   por el orden de narración), nunca por módulo. Varias escenas seguidas
 *   pueden compartir intención (mismo pasaje narrado), pero nunca el mismo
 *   recurso: eso lo impide el registro de identidad (asset-identity.ts).
 *
 * Puro: sin red ni proveedores.
 */
import type { WordTiming } from "@/lib/providers/types";
import type { BeatVisual } from "./visual-intents";
import { splitSentences } from "./visual-intents";

export type AnchoredIntent = {
  visual: BeatVisual;
  /** Índice de la descripción declarada/derivada dentro del beat. */
  visualIndex: number;
  /** Cuántas escenas ANTERIORES del beat ya usaron esta misma intención (0 = primera). */
  reuseIndex: number;
  /** "quote" = anclada por la cita declarada; "order" = por el orden de narración. */
  anchoredBy: "quote" | "order";
};

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export function narrationWords(narration: string): string[] {
  return narration.trim().split(/\s+/).filter(Boolean);
}

/**
 * Rango [primera, última] de índices de palabra narrados durante cada
 * escena. Con `words` (tiempos reales relativos al inicio del beat) se usa
 * el punto medio de cada palabra; sin ellos, reparto proporcional al tiempo.
 */
export function wordRangesForShots(
  shots: { startSec: number; endSec: number }[],
  beatStartSec: number,
  beatEndSec: number,
  narration: string,
  words?: WordTiming[],
): { first: number; last: number }[] {
  const count = words && words.length > 0 ? words.length : narrationWords(narration).length;
  if (count === 0) return shots.map(() => ({ first: 0, last: -1 }));
  const span = Math.max(1e-6, beatEndSec - beatStartSec);
  const mids =
    words && words.length > 0
      ? words.map((w) => (w.startSeconds + w.endSeconds) / 2)
      : Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * span);
  return shots.map((shot) => {
    const from = shot.startSec - beatStartSec;
    const to = shot.endSec - beatStartSec;
    let first = -1;
    let last = -1;
    for (let i = 0; i < mids.length; i++) {
      if (mids[i] >= from && mids[i] < to) {
        if (first === -1) first = i;
        last = i;
      }
    }
    if (first === -1) {
      // Pausa sin palabras: la palabra más cercana al centro de la escena.
      const center = (from + to) / 2;
      let best = 0;
      for (let i = 1; i < mids.length; i++) if (Math.abs(mids[i] - center) < Math.abs(mids[best] - center)) best = i;
      return { first: best, last: best };
    }
    return { first, last };
  });
}

export function fragmentForRange(narration: string, range: { first: number; last: number }, words?: WordTiming[]): string {
  const tokens = words && words.length > 0 ? words.map((w) => w.text) : narrationWords(narration);
  return tokens.slice(range.first, range.last + 1).join(" ").trim();
}

/**
 * Posición (índice de palabra) donde empieza la cita declarada de cada
 * intención, o null si no se encuentra en la narración.
 */
function quoteStart(narration: string, quote: string | undefined): number | null {
  if (!quote) return null;
  const tokens = narrationWords(narration).map(normalize);
  const q = normalize(quote).split(" ").filter(Boolean);
  if (q.length === 0) return null;
  const probe = q.slice(0, Math.min(4, q.length));
  for (let i = 0; i + probe.length <= tokens.length; i++) {
    if (probe.every((w, k) => tokens[i + k] === w)) return i;
  }
  return null;
}

/**
 * Tramo de palabras [inicio, fin) que cubre cada intención. Si TODAS las
 * intenciones traen una cita localizable, el tramo empieza en su cita; si
 * no, se reparte la narración en tramos contiguos por orden (el guionista
 * las declara "en el orden en que se narran"), alineados a oraciones.
 */
export function intentWordSpans(narration: string, visuals: BeatVisual[]): { start: number; end: number; anchoredBy: "quote" | "order" }[] {
  const total = narrationWords(narration).length;
  if (visuals.length === 0) return [];
  const starts = visuals.map((v) => quoteStart(narration, v.quote));
  if (starts.every((s) => s !== null)) {
    const order = visuals.map((_, i) => i).sort((a, b) => (starts[a] as number) - (starts[b] as number));
    const spans = new Array<{ start: number; end: number; anchoredBy: "quote" | "order" }>(visuals.length);
    order.forEach((vi, k) => {
      const start = k === 0 ? 0 : (starts[vi] as number);
      const end = k === order.length - 1 ? total : (starts[order[k + 1]] as number);
      spans[vi] = { start, end: Math.max(start + 1, end), anchoredBy: "quote" };
    });
    return spans;
  }
  // Por orden: límites en fronteras de oración cercanas al reparto uniforme.
  const sentenceStarts: number[] = [];
  let cursor = 0;
  for (const sentence of splitSentences(narration)) {
    sentenceStarts.push(cursor);
    cursor += narrationWords(sentence).length;
  }
  const bounds = [0];
  for (let k = 1; k < visuals.length; k++) {
    const ideal = Math.round((k * total) / visuals.length);
    const snapped = sentenceStarts.reduce((best, s) => (Math.abs(s - ideal) < Math.abs(best - ideal) ? s : best), ideal);
    bounds.push(Math.max(bounds[k - 1] + 1, Math.min(total - (visuals.length - k), snapped)));
  }
  bounds.push(total);
  return visuals.map((_, i) => ({ start: bounds[i], end: bounds[i + 1], anchoredBy: "order" as const }));
}

/** Intención anclada para cada escena (por el punto medio de su tramo narrado). */
export function anchorIntents(
  ranges: { first: number; last: number }[],
  narration: string,
  visuals: BeatVisual[],
): AnchoredIntent[] {
  const spans = intentWordSpans(narration, visuals);
  const uses = new Map<number, number>();
  return ranges.map((range) => {
    const mid = range.last >= range.first ? (range.first + range.last) / 2 : range.first;
    let index = spans.findIndex((s) => mid >= s.start && mid < s.end);
    if (index === -1) index = mid < (spans[0]?.start ?? 0) ? 0 : spans.length - 1;
    const reuseIndex = uses.get(index) ?? 0;
    uses.set(index, reuseIndex + 1);
    return { visual: visuals[index], visualIndex: index, reuseIndex, anchoredBy: spans[index].anchoredBy };
  });
}

/**
 * Dato destacable del fragmento (año, cifra con unidad, porcentaje) — lo
 * único que justifica una tarjeta de texto automática. Sin dato, la
 * escena debe ser visual: una tarjeta que solo repite el título o la
 * narración no aporta.
 */
export function salientFact(fragment: string): string | null {
  const year = /\b(1[5-9]\d\d|20\d\d)\b/.exec(fragment);
  const quantity =
    /\b(\d{1,3}(?:[.,\s]\d{3})+|\d+(?:[.,]\d+)?)\s*(%|por ciento|kil[oó]metros|km|metros|millones|mil|toneladas|horas|d[ií]as|años|trabajadores|barcos|personas|muertos)\b/i.exec(
      fragment,
    );
  if (quantity) return `${quantity[1]} ${quantity[2]}`.trim();
  if (year) return year[1];
  return null;
}

/** Recorta al límite de caracteres en frontera de palabra. */
export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), Math.floor(max * 0.6))).trimEnd()}…`;
}

/**
 * Lleva un corte de escena al silencio entre palabras más cercano (tiempos
 * reales de la síntesis), `lead` segundos antes de que empiece la palabra
 * siguiente y nunca dentro de una palabra. Si no hay silencio a menos de
 * `maxShift` s, devuelve el punto medio del hueco entre palabras más
 * cercano (o `t` sin cambios si no hay palabras).
 */
export function snapBoundaryToSpeech(
  t: number,
  words: { startSeconds: number; endSeconds: number }[],
  opts: { lead?: number; maxShift?: number } = {},
): number {
  const lead = opts.lead ?? 0.12;
  const maxShift = opts.maxShift ?? 0.8;
  if (words.length < 2) return t;
  let best: number | null = null;
  for (let i = 0; i < words.length - 1; i++) {
    const gapStart = words[i].endSeconds;
    const gapEnd = words[i + 1].startSeconds;
    if (gapEnd < gapStart) continue;
    const cut = Math.max(gapStart, gapEnd - lead);
    if (Math.abs(cut - t) <= maxShift && (best === null || Math.abs(cut - t) < Math.abs(best - t))) best = cut;
  }
  return best === null ? t : +best.toFixed(3);
}

/** true si el instante cae DENTRO de una palabra narrada (un corte ahí la partiría). */
export function cutsThroughWord(t: number, words: { startSeconds: number; endSeconds: number }[], toleranceSec = 0.01): boolean {
  return words.some((w) => t > w.startSeconds + toleranceSec && t < w.endSeconds - toleranceSec);
}
