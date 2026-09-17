import type { FootageCandidate, FootageProvider, FootageResult } from "@/lib/providers/types";
import { MIN_ACCEPTABLE_SCORE, scoreCandidate, type ScoredCandidate } from "./footage-score";

/**
 * Selector de footage con candidatos múltiples, puntuación y
 * deduplicación — reemplaza el patrón anterior (una sola consulta, un
 * solo resultado, sin memoria entre escenas) que era la causa raíz
 * confirmada de "solo ~4 clips distintos" y "atardecer repetido" en el
 * video auditado (fc7534a0): con una única búsqueda de 2-4 palabras por
 * escena y sin registro de lo ya usado, escenas con conceptos similares
 * (muy probable — "motivation", "discipline", "success"... todas caen en
 * el mismo puñado de fotos de archivo típicas) terminaban repitiendo el
 * mismo clip.
 *
 * El estado (`FootageSelectionState`) se comparte entre TODAS las escenas
 * de un mismo video — así la regla "ningún clip debe repetirse" se aplica
 * al video completo, no escena por escena.
 */

export type FootageSelectionState = {
  usedSourceIds: Set<string>;
  photographerUseCount: Map<string, number>;
};

export function createFootageSelectionState(): FootageSelectionState {
  return { usedSourceIds: new Set(), photographerUseCount: new Map() };
}

export type FootageSelectionOutcome = {
  result: FootageResult;
  sourceId: string;
  /** Explicación legible de por qué se eligió este candidato — para logs/tests, nunca mostrado al usuario final. */
  reason: string;
  usedFallbackQuery: boolean;
  queryUsed: string;
  conceptTier: number;
  candidatesConsidered: number;
};

export class FootageSelectionError extends Error {
  constructor(public readonly concepts: string[]) {
    super(
      `Ningún candidato de footage superó el umbral mínimo para los conceptos: ${concepts.join(" | ")}`,
    );
    this.name = "FootageSelectionError";
  }
}

/** Reformulación simple: las 1-2 primeras palabras del concepto principal, soltando calificadores que pueden estar sobre-especificando la búsqueda. */
export function buildFallbackQuery(primaryConcept: string): string {
  const words = primaryConcept.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "b-roll";
  return words.slice(0, Math.min(2, words.length)).join(" ");
}

type TieredScoredCandidate = ScoredCandidate & { tier: number; query: string };

async function collectScored(
  concepts: string[],
  search: (query: string, tier: number) => Promise<FootageCandidate[]>,
  minimumDurationSeconds: number,
  state: FootageSelectionState,
): Promise<{ scored: TieredScoredCandidate[]; totalCandidates: number }> {
  const scored: TieredScoredCandidate[] = [];
  let totalCandidates = 0;

  for (let tier = 0; tier < concepts.length; tier++) {
    const query = concepts[tier];
    const candidates = await search(query, tier);
    totalCandidates += candidates.length;

    for (const candidate of candidates) {
      if (state.usedSourceIds.has(candidate.sourceId)) continue; // nunca reutilizar el mismo clip
      const result = scoreCandidate(candidate, {
        conceptTier: tier,
        photographerUseCount: state.photographerUseCount,
        minimumDurationSeconds,
      });
      scored.push({ ...result, tier, query });
    }
  }

  return { scored, totalCandidates };
}

function rankTiered(scored: TieredScoredCandidate[]): TieredScoredCandidate[] {
  return [...scored].sort((a, b) => b.score - a.score);
}

function commit(
  best: TieredScoredCandidate,
  state: FootageSelectionState,
  usedFallbackQuery: boolean,
  candidatesConsidered: number,
): FootageSelectionOutcome {
  state.usedSourceIds.add(best.candidate.sourceId);
  const photographer = best.candidate.photographer?.trim().toLowerCase();
  if (photographer) {
    state.photographerUseCount.set(photographer, (state.photographerUseCount.get(photographer) ?? 0) + 1);
  }

  const { sourceId, ...result } = best.candidate;
  return {
    result,
    sourceId,
    reason: best.reasons.join("; ") + ` (score=${best.score})`,
    usedFallbackQuery,
    queryUsed: best.query,
    conceptTier: best.tier,
    candidatesConsidered,
  };
}

export async function selectFootageForScene({
  provider,
  concepts,
  minimumDurationSeconds,
  state,
}: {
  provider: FootageProvider;
  /** Ya debe incluir el concepto principal como primer elemento. */
  concepts: string[];
  minimumDurationSeconds: number;
  state: FootageSelectionState;
}): Promise<FootageSelectionOutcome> {
  const effectiveConcepts = concepts.length > 0 ? concepts : ["b-roll motivational"];

  const searchVideo = provider.searchVideoCandidates?.bind(provider);
  const searchImage = provider.searchImageCandidates?.bind(provider);

  // Proveedor sin soporte de candidatos múltiples (p. ej. el fixture de
  // desarrollo): usa fetchFootage tal cual, sin puntuar ni diversificar —
  // sigue siendo válido para probar el pipeline sin Pexels, pero no
  // aplica ninguna de las mejoras de esta fase.
  if (!searchVideo && !searchImage) {
    const result = await provider.fetchFootage(effectiveConcepts[0], minimumDurationSeconds);
    const sourceId = `${provider.name}-${result.url}`;
    state.usedSourceIds.add(sourceId);
    return {
      result,
      sourceId,
      reason: `proveedor "${provider.name}" sin candidatos múltiples — usado tal cual`,
      usedFallbackQuery: false,
      queryUsed: effectiveConcepts[0],
      conceptTier: 0,
      candidatesConsidered: 1,
    };
  }

  // 1) Video, probando cada concepto en orden (el principal primero).
  if (searchVideo) {
    const { scored, totalCandidates } = await collectScored(
      effectiveConcepts,
      (query) => searchVideo(query, minimumDurationSeconds).then((c) => c ?? []),
      minimumDurationSeconds,
      state,
    );
    const ranked = rankTiered(scored);
    const best = ranked[0];
    if (best && best.score >= MIN_ACCEPTABLE_SCORE) {
      return commit(best, state, false, totalCandidates);
    }

    // 2) Reformular el concepto principal y reintentar solo video, una vez.
    const fallbackQuery = buildFallbackQuery(effectiveConcepts[0]);
    const fallback = await collectScored(
      [fallbackQuery],
      (query) => searchVideo(query, minimumDurationSeconds).then((c) => c ?? []),
      minimumDurationSeconds,
      state,
    );
    const fallbackRanked = rankTiered(fallback.scored);
    const fallbackBest = fallbackRanked[0];
    if (fallbackBest && fallbackBest.score >= MIN_ACCEPTABLE_SCORE) {
      console.warn(
        `[atomivid:footage] fallback de consulta: "${effectiveConcepts[0]}" → "${fallbackQuery}" ` +
          `(ningún candidato de video superó el umbral con los conceptos originales)`,
      );
      return commit(fallbackBest, state, true, fallback.totalCandidates);
    }
  }

  // 3) Último recurso: imagen, con los conceptos originales.
  if (searchImage) {
    const { scored, totalCandidates } = await collectScored(
      effectiveConcepts,
      (query) => searchImage(query),
      minimumDurationSeconds,
      state,
    );
    const ranked = rankTiered(scored);
    const best = ranked[0];
    if (best) {
      console.warn(
        `[atomivid:footage] sin video aprovechable para [${effectiveConcepts.join(" | ")}] — se usa una imagen`,
      );
      return commit(best, state, true, totalCandidates);
    }
  }

  throw new FootageSelectionError(effectiveConcepts);
}
