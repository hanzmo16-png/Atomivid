import type { FootageCandidate } from "@/lib/providers/types";

/**
 * Puntuación de candidatos de footage — aproximación explícita, no
 * "relevancia semántica" real: Pexels no expone tags/descripciones ricas
 * por candidato en su respuesta de búsqueda (solo dimensiones, duración y
 * fotógrafo), así que no hay forma de medir con este proveedor si el
 * CONTENIDO visual de un candidato corresponde de verdad a la idea de la
 * escena — eso requeriría un modelo de visión o embeddings sobre miniaturas,
 * un paso pagado que no está autorizado sin aprobación explícita (ver
 * comparación de proveedores en el reporte de esta fase). Lo que SÍ se
 * puede medir y puntuar con los datos disponibles:
 *
 * - qué tan directo es el concepto que produjo el candidato (el primero
 *   de la lista es la interpretación principal de la escena; los
 *   siguientes son alternativas cada vez más amplias);
 * - video vs. imagen (movimiento real > foto estática);
 * - calidad técnica (resolución vertical suficiente);
 * - si el mismo fotógrafo ya se usó antes en este video (proxy barato de
 *   "puede ser visualmente parecido a algo que ya se mostró", sin serlo
 *   necesariamente).
 *
 * La deduplicación real (nunca repetir el mismo clip) es un chequeo
 * aparte, exacto por `sourceId` — no depende de este score.
 */

export type ScoredCandidate = {
  candidate: FootageCandidate;
  score: number;
  reasons: string[];
};

export const MIN_ACCEPTABLE_SCORE = 4;

export function scoreCandidate(
  candidate: FootageCandidate,
  opts: {
    /** Índice del concepto que produjo este candidato (0 = principal). */
    conceptTier: number;
    photographerUseCount: ReadonlyMap<string, number>;
    minimumDurationSeconds: number;
  },
): ScoredCandidate {
  const reasons: string[] = [];
  let score = 10;

  const tierPenalty = opts.conceptTier * 2;
  score -= tierPenalty;
  reasons.push(
    opts.conceptTier === 0
      ? "concepto visual principal"
      : `concepto alternativo #${opts.conceptTier + 1} (-${tierPenalty})`,
  );

  if (candidate.mediaType === "video") {
    score += 3;
    reasons.push("es video (movimiento real, +3)");
  } else {
    reasons.push("es imagen estática (sin bonus de movimiento)");
  }

  if (typeof candidate.width === "number") {
    if (candidate.width >= 1080) {
      score += 2;
      reasons.push("resolución ≥1080px (+2)");
    } else if (candidate.width >= 720) {
      score += 1;
      reasons.push("resolución ≥720px (+1)");
    } else {
      reasons.push("resolución por debajo de 720px (sin bonus)");
    }
  }

  if (candidate.mediaType === "video" && typeof candidate.durationSeconds === "number") {
    const excess = candidate.durationSeconds - opts.minimumDurationSeconds;
    if (excess >= 0 && excess <= opts.minimumDurationSeconds * 2) {
      score += 1;
      reasons.push("duración del clip ajustada a lo necesario (+1)");
    }
  }

  const photographer = candidate.photographer?.trim().toLowerCase();
  if (photographer) {
    const uses = opts.photographerUseCount.get(photographer) ?? 0;
    if (uses > 0) {
      const penalty = uses * 2;
      score -= penalty;
      reasons.push(
        `mismo autor ya usado ${uses} vez/veces en este video (-${penalty}, riesgo de repetición visual)`,
      );
    }
  }

  return { candidate, score, reasons };
}

/** Ordena de mejor a peor; empates se resuelven por orden de llegada (estable). */
export function rankCandidates(scored: ScoredCandidate[]): ScoredCandidate[] {
  return [...scored].sort((a, b) => b.score - a.score);
}
