import type { FootageCandidate } from "@/lib/providers/types";

/**
 * Puntuación técnica y de diversidad, no inspección del contenido visual.
 * La apertura pasa antes por opening-relevance.ts usando la descripción
 * pública del proveedor. Esa comprobación textual tampoco inspecciona píxeles.
 * Aquí se puntúa:
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

  // VerticalReel fills 9:16 with objectFit: cover. A landscape file's full
  // width is not usable resolution: 1920x1080 leaves only ~608x1080 after
  // that crop, whereas 720x1280 portrait retains all its pixels. This is a
  // resolution estimate, not subject/framing inspection or a hard rejection.
  const { width, height } = candidate;
  if (typeof width === "number" && typeof height === "number" &&
      Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    const usableWidth = Math.min(width, height * 9 / 16);
    if (usableWidth >= 1080) {
      score += 2;
      reasons.push("resolución útil 9:16 ≥1080x1920 (+2)");
    } else if (usableWidth >= 720) {
      score += 1;
      reasons.push("resolución útil 9:16 ≥720x1280 (+1)");
    } else {
      reasons.push("resolución útil 9:16 por debajo de 720x1280 (sin bonus)");
    }
  } else {
    reasons.push("resolución útil 9:16 sin comprobar (dimensiones incompletas o inválidas)");
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
