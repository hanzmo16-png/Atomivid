/**
 * Palabras que reciben énfasis visual en los subtítulos (color de acento,
 * ver remotion/VerticalReel.tsx) — causa raíz confirmada del defecto "no
 * existe jerarquía visual ni énfasis en palabras importantes": antes,
 * TODAS las palabras se mostraban con el mismo peso visual, sin importar
 * su importancia narrativa.
 *
 * Lista por defecto sembrada con las palabras que el propio brief de
 * calidad señaló como ejemplo ("motivación", "disciplina", "triunfan",
 * "hábito", "constantes") más sinónimos cercanos — se usa cuando el guion
 * no trae su propia lista de énfasis. La lista del guion (si existe) se
 * une a esta, nunca la reemplaza — el guionista puede añadir palabras
 * clave del tema, pero el vocabulario motivacional base sigue vigente.
 */
export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const DEFAULT_EMPHASIS_WORDS = [
  "motivacion",
  "motivation",
  "disciplina",
  "discipline",
  "triunfan",
  "triunfo",
  "triunfar",
  "habito",
  "habitos",
  "habit",
  "habits",
  "constancia",
  "constante",
  "constantes",
  "consistency",
  "consistent",
  "esfuerzo",
  "effort",
  "perseverancia",
  "perseverance",
  "exito",
  "success",
  "fracaso",
  "failure",
  "meta",
  "metas",
  "goal",
  "goals",
  "sueños",
  "sueno",
  "suenos",
  "dreams",
];

export function buildEmphasisSet(scriptEmphasisWords: string[] = []): Set<string> {
  const set = new Set(DEFAULT_EMPHASIS_WORDS.map(normalizeWord));
  for (const word of scriptEmphasisWords) {
    const normalized = normalizeWord(word);
    if (normalized) set.add(normalized);
  }
  return set;
}

/** true si `word` (tal cual aparece en el texto narrado, con puntuación) debe enfatizarse. */
export function isEmphasisWord(word: string, emphasisSet: ReadonlySet<string>): boolean {
  return emphasisSet.has(normalizeWord(word));
}
