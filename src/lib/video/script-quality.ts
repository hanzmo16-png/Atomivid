import type { GeneratedScript } from "@/lib/providers/types";

/**
 * Filtro de calidad aplicado después de generar un guion, antes de
 * marcarlo como "script_ready" — un guion sintácticamente válido (con
 * título y escenas) no es lo mismo que un guion apto para publicar. Nunca
 * reemplaza el juicio humano (quien revisa/edita el guion en
 * /dashboard/review/[id] sigue siendo la última palabra), pero atrapa los
 * casos obvios que antes se presentaban en silencio como si fueran un
 * resultado terminado:
 *   1. El proveedor de guion usado no fue el de IA real (fallback
 *      silencioso al proveedor fixture, típicamente por
 *      ANTHROPIC_API_KEY ausente).
 *   2. La misma frase aparece repetida literalmente (dentro de una
 *      escena o entre varias) — la firma exacta del fixture cuando el
 *      tema es corto (rellena escenas repitiendo su propia plantilla).
 *   3. Dos o más escenas piden la misma búsqueda visual.
 *   4. Una búsqueda visual es (o contiene) el tema completo en vez de
 *      una consulta concreta — también firma del fixture.
 *   5. El total de palabras está muy lejos del objetivo calculado para
 *      la duración pedida (guion roto o truncado).
 */

export type ScriptQualityIssue =
  | "fallback_provider"
  | "excessive_repetition"
  | "duplicate_visual_queries"
  | "generic_visual_query"
  | "word_count_out_of_range";

export type ScriptQualityResult =
  | { ok: true }
  | { ok: false; issue: ScriptQualityIssue; detail: string };

const MIN_REPEATED_SENTENCE_WORDS = 3;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => normalize(s))
    .filter(Boolean);
}

export function checkScriptQuality(
  script: Pick<GeneratedScript, "segments">,
  {
    topic,
    targetWords,
    providerName,
  }: {
    topic: string;
    /** Objetivo calculado con targetWordsFor(durationSeconds) — ver script-pacing.ts. */
    targetWords: number;
    /** scriptProvider.name en el momento de la generación — "anthropic" es el único proveedor de IA real. */
    providerName: string;
  },
): ScriptQualityResult {
  if (providerName !== "anthropic") {
    return {
      ok: false,
      issue: "fallback_provider",
      detail: `El guion se generó con el proveedor "${providerName}", no con el proveedor de IA principal.`,
    };
  }

  const sentenceCounts = new Map<string, number>();
  for (const segment of script.segments) {
    for (const sentence of splitSentences(segment.text)) {
      sentenceCounts.set(sentence, (sentenceCounts.get(sentence) ?? 0) + 1);
    }
  }
  for (const [sentence, count] of sentenceCounts) {
    if (count > 1 && sentence.split(" ").length >= MIN_REPEATED_SENTENCE_WORDS) {
      return {
        ok: false,
        issue: "excessive_repetition",
        detail: `Una frase se repite ${count} veces en el guion.`,
      };
    }
  }

  const visualQueries = script.segments.map((s) => normalize(s.visualQuery));
  const seenQueries = new Set<string>();
  for (const query of visualQueries) {
    if (query && seenQueries.has(query)) {
      return {
        ok: false,
        issue: "duplicate_visual_queries",
        detail: "Dos o más escenas piden la misma búsqueda visual.",
      };
    }
    seenQueries.add(query);
  }

  const normalizedTopic = normalize(topic);
  if (normalizedTopic.length >= 8) {
    for (const query of visualQueries) {
      if (query && (query === normalizedTopic || query.includes(normalizedTopic))) {
        return {
          ok: false,
          issue: "generic_visual_query",
          detail: "Una búsqueda visual repite el tema completo en vez de una consulta concreta.",
        };
      }
    }
  }

  if (targetWords > 0) {
    const totalWords = script.segments.reduce(
      (sum, s) => sum + s.text.split(/\s+/).filter(Boolean).length,
      0,
    );
    if (totalWords < targetWords * 0.9 || totalWords > targetWords * 1.1) {
      return {
        ok: false,
        issue: "word_count_out_of_range",
        detail: `El guion tiene ${totalWords} palabras, muy lejos del objetivo (~${targetWords}).`,
      };
    }
  }

  return { ok: true };
}

/** Error tipado para que classifyScriptError/logScriptError lo distingan de un fallo de red o de proveedor. */
export class ScriptQualityError extends Error {
  constructor(public readonly result: Extract<ScriptQualityResult, { ok: false }>) {
    super(`Guion rechazado por control de calidad: ${result.issue} — ${result.detail}`);
    this.name = "ScriptQualityError";
  }
}
