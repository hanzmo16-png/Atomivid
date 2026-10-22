/** Detección léxica de fechas de calendario (día + mes, es/en, o ISO). Módulo puro y sin dependencias: lo comparten el
 * preflight fechado y la planificación de escenas (visual-intents.ts) sin ciclos de importación. */
export const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const ES_MONTHS = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre";
// «mar» queda fuera de las abreviaturas sueltas: en español es «el mar» («en el mar 20 barcos…»). Solo cuenta con
// punto («Mar. 5») o con año («Mar 5, 2024»), igual que «may».
const EN_MONTHS = "january|february|march|april|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const DATE_PATTERNS: RegExp[] = [
  // «10 de mayo», «10 de mayo de 2024», «1.º de julio del 1969»
  new RegExp(`\\b([0-3]?\\d)(?:\\.?º|\\.?o)?\\s+de\\s+(?:${ES_MONTHS})(?:\\s+(?:de|del)\\s+\\d{3,4})?\\b`, "g"),
  // "May 10, 2024", "July 20th 1969", "Oct. 3" ("may" solo con año: también es un verbo)
  new RegExp(`\\b(?:${EN_MONTHS})\\.?\\s+[0-3]?\\d(?:st|nd|rd|th)?(?:,?\\s+\\d{3,4})?\\b`, "g"),
  /\bmay\s+[0-3]?\d(?:st|nd|rd|th)?,?\s+\d{4}\b/g,
  /\bmar\.\s*[0-3]?\d(?:st|nd|rd|th)?\b/g,
  /\bmar\s+[0-3]?\d(?:st|nd|rd|th)?,?\s+\d{4}\b/g,
  // "10 May 2024", "20th of July 1969"
  new RegExp(`\\b[0-3]?\\d(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${EN_MONTHS}|may|mar)\\.?,?\\s+\\d{3,4}\\b`, "g"),
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

export function sentences(narration: string): string[] {
  return narration.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** true si la cita de una escena cae dentro de una oración de la narración que contiene una fecha de calendario. */
export function anchoredToDatedPassage(narration: string, quote: string | undefined): boolean {
  if (typeof quote !== "string" || !quote.trim()) return false;
  const q = fold(quote).trim();
  return sentences(narration).some((sentence) => calendarDatesIn(sentence).length > 0 && fold(sentence).includes(q));
}
