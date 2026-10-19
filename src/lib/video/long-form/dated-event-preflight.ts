/**
 * P0-01 (T-20261019-1553): preflight de VERACIDAD para planes v3 (ruta por defecto del producto).
 *
 * Un plan v3 no lee clase/identidad/prueba de las escenas (usesVisualIdentity = v4+), así que no
 * pasa por visualReleasePreflight y solo puede mostrar material ILUSTRATIVO (stock o imagen IA).
 * Si el guion narra un acontecimiento con FECHA DE CALENDARIO concreta («la noche del 10 de mayo
 * de 2024», "On May 10, 2024") y una escena ilustrativa queda anclada a ese pasaje, el espectador
 * la tomaría por prueba del hecho. Eso se detiene ANTES de cualquier gasto (sin voz, sin stock,
 * sin imagen, sin render): fallo cerrado con IMPEDIMENTO DE ENTREGA, no un aviso pasivo.
 *
 * Función pura: sin red, sin Supabase, sin proveedores. Compartida por el worker (produce.ts), la
 * página Configurar / el arranque (production-preflight.ts → visualCheck) y la confirmación del plan.
 *
 * Límites (explícitos, a auditar): detección LÉXICA de fechas con día + mes (es/en) o ISO
 * AAAA-MM-DD. No detecta «mayo de 2024» sin día, ni años sueltos («en 2003»), ni eventos sin fecha.
 * Una visual sin `quote` en un beat fechado se trata como anclada al pasaje fechado (fallo cerrado).
 */
import { LongFormVisualQualityError } from "./visual-report";

export const DATED_EVENT_EVIDENCE_REQUIRED = "DATED_EVENT_EVIDENCE_REQUIRED";

type BeatLike = { id?: string; narration: string; visuals?: unknown };
type VisualLike = { description?: unknown; quote?: unknown };

export type DatedEventFinding = { beatId: string; date: string; sentence: string; visuals: string[] };

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const ES_MONTHS = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre";
const EN_MONTHS = "january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const DATE_PATTERNS: RegExp[] = [
  // «10 de mayo», «10 de mayo de 2024», «1.º de julio del 1969»
  new RegExp(`\\b([0-3]?\\d)(?:\\.?º|\\.?o)?\\s+de\\s+(?:${ES_MONTHS})(?:\\s+(?:de|del)\\s+\\d{3,4})?\\b`, "g"),
  // "May 10, 2024", "July 20th 1969", "Oct. 3" ("may" solo con año: también es un verbo)
  new RegExp(`\\b(?:${EN_MONTHS})\\.?\\s+[0-3]?\\d(?:st|nd|rd|th)?(?:,?\\s+\\d{3,4})?\\b`, "g"),
  /\bmay\s+[0-3]?\d(?:st|nd|rd|th)?,?\s+\d{4}\b/g,
  // "10 May 2024", "20th of July 1969"
  new RegExp(`\\b[0-3]?\\d(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${EN_MONTHS}|may)\\.?,?\\s+\\d{3,4}\\b`, "g"),
  // ISO 2024-05-10
  /\b\d{4}-[01]\d-[0-3]\d\b/g,
];

/** Fechas de calendario (día + mes) presentes en el texto, tal como aparecen (texto plegado). */
export function calendarDatesIn(text: string): string[] {
  const t = fold(text);
  const found = new Set<string>();
  for (const re of DATE_PATTERNS) for (const m of t.matchAll(re)) found.add(m[0].trim());
  return [...found];
}

function sentences(narration: string): string[] {
  return narration.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Escenas ilustrativas que quedarían ancladas a un pasaje con fecha de calendario.
 * Vacío = el guion no presenta ningún acontecimiento fechado como si lo mostrara.
 */
export function datedEventFindings(beats: readonly BeatLike[]): DatedEventFinding[] {
  const out: DatedEventFinding[] = [];
  beats.forEach((beat, index) => {
    const beatId = beat.id ?? `beat-${index + 1}`;
    const visuals = (Array.isArray(beat.visuals) ? beat.visuals : []) as VisualLike[];
    for (const sentence of sentences(beat.narration ?? "")) {
      const dates = calendarDatesIn(sentence);
      if (dates.length === 0) continue;
      const folded = fold(sentence);
      // Sin visuales declaradas, la escena se deriva del propio pasaje: siempre anclada (fallo cerrado).
      const anchored = visuals.length === 0
        ? ["(visual derivada del pasaje)"]
        : visuals
            .filter((v) => typeof v.quote !== "string" || v.quote.trim() === "" || folded.includes(fold(v.quote).trim()))
            .map((v) => (typeof v.description === "string" && v.description) || "(visual sin descripción)");
      if (anchored.length > 0) out.push({ beatId, date: dates[0], sentence, visuals: anchored });
    }
  });
  return out;
}

/** Bloqueantes en el formato de LongFormVisualQualityError («CÓDIGO: detalle (beat)»). */
export function datedEventEvidenceBlockers(beats: readonly BeatLike[]): string[] {
  return datedEventFindings(beats).map(
    (f) => `${DATED_EVENT_EVIDENCE_REQUIRED}: el pasaje con fecha «${f.date}» se ilustraría con material genérico (${f.visuals.join("; ")}) que el espectador tomaría por imagen del hecho (${f.beatId})`,
  );
}

/** Frase para el usuario (sin códigos internos: customer-error.ts los oculta). */
export function datedEventBlockMessage(count: number): string {
  return (
    `IMPEDIMENTO DE ENTREGA: el guion narra ${count === 1 ? "un acontecimiento con fecha concreta" : `${count} pasajes con fecha concreta`} y esta ruta solo dispone de material ilustrativo, ` +
    "que se mostraría como si fuera del propio hecho. No se inició, reservó ni cobró nada. Para continuar hace falta material verificado del acontecimiento (ruta con curaduría de pruebas) " +
    "o reformular el pasaje para que no se presente como imagen del hecho."
  );
}

/** Fallo cerrado ANTES de cualquier gasto (subclase: los manejadores de LongFormVisualQualityError siguen valiendo). */
export class LongFormDatedEventEvidenceError extends LongFormVisualQualityError {
  constructor(problems: string[]) {
    super(problems);
    this.name = "LongFormDatedEventEvidenceError";
    this.message = `${datedEventBlockMessage(problems.length)} Detalle: ${problems.join("; ")}.`;
  }
}
