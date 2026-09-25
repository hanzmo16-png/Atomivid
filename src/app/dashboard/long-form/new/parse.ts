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
