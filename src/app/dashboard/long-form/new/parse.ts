import type { LongFormSource } from "@/lib/video/long-form/types";

export const MAX_SOURCES = 20;
export const MAX_OPEN_QUESTIONS = 10;

/** Una fuente por línea: "Título | URL o referencia (opcional) | nota (opcional)". */
export function parseSources(raw: string): LongFormSource[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_SOURCES)
    .map((line, i) => {
      const [title, locator, notes] = line.split("|").map((part) => part.trim());
      return {
        id: `src-${i + 1}`,
        title: title || line,
        kind: "secondary" as const,
        locator: locator || undefined,
        notes: notes || undefined,
      };
    });
}

export function parseOpenQuestions(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_OPEN_QUESTIONS);
}

/**
 * The brief text sometimes states its own duration or language ("Duración: 9 minutos. Idioma: español"), while the
 * job runs on the form FIELDS. 54740b5a asked for 9 minutes in Spanish and ran as 7 minutes in English. When the text
 * contradicts a field, stop before saving anything and say which field to change; never guess which one is right.
 */
export function briefFieldConflict(topic: string, durationMinutes: number, language: "es" | "en"): string | null {
  const text = topic.toLowerCase();
  const minutes = /(\d{1,2})\s*(?:-|a|–)?\s*(?:\d{1,2}\s*)?(?:minutos|minutes|min\b)/.exec(text);
  if (minutes && Number(minutes[1]) !== durationMinutes)
    return `El tema dice ${minutes[1]} minutos, pero el campo «Duración objetivo» tiene ${durationMinutes}. Ajusta el campo (es el que manda) y vuelve a enviar; no se inició nada ni se cobró.`;
  const saysSpanish = /\b(?:idioma|language)\s*:?\s*(?:español|espanol|spanish)|\ben español\b|\bin spanish\b/.test(text);
  const saysEnglish = /\b(?:idioma|language)\s*:?\s*(?:inglés|ingles|english)|\ben inglés\b|\bin english\b/.test(text);
  if ((saysSpanish && language !== "es") || (saysEnglish && language !== "en"))
    return `El tema pide la narración en ${saysSpanish ? "español" : "inglés"}, pero el campo «Idioma de la narración» está en ${language === "es" ? "español" : "inglés"}. Ajusta el campo y vuelve a enviar; no se inició nada ni se cobró.`;
  return null;
}
