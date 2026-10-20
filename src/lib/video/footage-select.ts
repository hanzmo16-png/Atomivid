import type { FootageCandidate, FootageProvider, FootageResult } from "@/lib/providers/types";
import { MIN_ACCEPTABLE_SCORE, scoreCandidate, type ScoredCandidate } from "./footage-score";
import { metadataMatch, sceneVisualIntent, type SceneVisualIntent, type VisualFacet } from "./scene-visual-intent";
import { assessOpeningRelevance, openingFallbackQuery, OpeningFootageUnavailableError, type OpeningRelevance } from "./opening-relevance";

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
  openingRelevance?: OpeningRelevance;
  providerDescription?: string;
  providerPageUrl?: string;
  /** Intención observable aplicada (null = sin regla: sólo palabras del concepto). */
  intentId?: string | null;
  /** Facetas de la intención halladas en los METADATOS del clip elegido (no verificación visual). */
  metadataFacets?: VisualFacet[];
  /** "metadata" = el clip elegido coincide en metadatos; "none" = no hubo coincidencia y se usó el mejor técnico. */
  metadataMatch?: "metadata" | "none" | "unchecked";
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
export function buildFallbackQuery(primaryConcept: string, intent?: SceneVisualIntent | null): string {
  // Con intención observable, la reformulación conserva acción + entorno (no «las 2 primeras palabras»).
  if (intent) return intent.fallbackQuery;
  const words = primaryConcept.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "b-roll";
  return words.slice(0, Math.min(2, words.length)).join(" ");
}

type TieredScoredCandidate = ScoredCandidate & { tier: number; query: string; openingRelevance?: OpeningRelevance; facets: VisualFacet[]; described: boolean; contradicted: boolean; technicalScore: number };

async function collectScored(
  concepts: string[],
  search: (query: string, tier: number) => Promise<FootageCandidate[]>,
  minimumDurationSeconds: number,
  state: FootageSelectionState,
  opening?: { concepts: string[]; excludedTerms: string[] },
  intent: SceneVisualIntent | null = null,
): Promise<{ scored: TieredScoredCandidate[]; totalCandidates: number }> {
  const scored: TieredScoredCandidate[] = [];
  let totalCandidates = 0;

  for (let tier = 0; tier < concepts.length; tier++) {
    const query = concepts[tier];
    const candidates = await search(query, tier);
    totalCandidates += candidates.length;

    for (const candidate of candidates) {
      if (state.usedSourceIds.has(candidate.sourceId)) continue; // nunca reutilizar el mismo clip
      const openingRelevance = opening ? assessOpeningRelevance(candidate, opening.concepts, opening.excludedTerms) : undefined;
      if (openingRelevance && !openingRelevance.accepted) continue;
      const result = scoreCandidate(candidate, {
        conceptTier: tier,
        photographerUseCount: state.photographerUseCount,
        minimumDurationSeconds,
      });
      if (openingRelevance) result.reasons.push(openingRelevance.reason);
      const match = metadataMatch(candidate.description, intent, query);
      const technicalScore = result.score;
      // Preserve the established opening gate AND ranking. Narrative heuristics
      // must not veto an otherwise valid hook or change its technical threshold.
      if (!opening) result.score += match.points;
      result.reasons.push(match.reason);
      scored.push({ ...result, tier, query, openingRelevance, facets: match.matchedFacets, described: !!candidate.description?.trim(), contradicted: match.contradicted.length > 0, technicalScore });
    }
  }

  return { scored, totalCandidates };
}

/** Con intención, un clip cuyos metadatos CONTRADICEN la escena no es aceptable en video (se reformula). */
const acceptable = (c: TieredScoredCandidate, intent: SceneVisualIntent | null) =>
  c.score >= MIN_ACCEPTABLE_SCORE && !c.contradicted && (!intent || c.facets.length >= 2);

function rankTiered(scored: TieredScoredCandidate[]): TieredScoredCandidate[] {
  return [...scored].sort((a, b) =>
    (b.openingRelevance?.matchedTerms.length ?? 0) - (a.openingRelevance?.matchedTerms.length ?? 0) || b.score - a.score);
}

function commit(
  best: TieredScoredCandidate,
  state: FootageSelectionState,
  usedFallbackQuery: boolean,
  candidatesConsidered: number,
  intent: SceneVisualIntent | null = null,
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
    providerDescription: best.candidate.description,
    providerPageUrl: best.candidate.pageUrl,
    conceptTier: best.tier,
    candidatesConsidered,
    intentId: intent?.id ?? null,
    metadataFacets: best.facets,
    metadataMatch: !best.described ? "unchecked" : !best.contradicted && (intent ? best.facets.length >= 2 : best.reasons.some((r) => /palabras del concepto en metadatos: (?!ninguna)/.test(r))) ? "metadata" : "none",
    ...(best.openingRelevance ? { openingRelevance: best.openingRelevance } : {}),
  };
}

export async function selectFootageForScene({
  provider,
  concepts,
  minimumDurationSeconds,
  state,
  isOpening = false,
  excludedTerms = [],
  narration,
}: {
  provider: FootageProvider;
  /** Ya debe incluir el concepto principal como primer elemento. */
  concepts: string[];
  minimumDurationSeconds: number;
  state: FootageSelectionState;
  isOpening?: boolean;
  excludedTerms?: string[];
  /** Texto narrado de la escena: de él sale la intención observable (acción, entorno, postura, vestuario, emoción). */
  narration?: string;
}): Promise<FootageSelectionOutcome> {
  const intent = isOpening ? null : sceneVisualIntent(narration, concepts);
  // Búsquedas ACOTADAS: como máximo 3 consultas por tipo de medio (+1 reformulación de video), igual que antes.
  // Con intención (y fuera de la apertura, que tiene su propia regla de pertinencia), la consulta enriquecida va primero.
  const baseConcepts = concepts.length > 0 ? concepts : ["b-roll motivational"];
  const effectiveConcepts = intent && !isOpening
    ? [intent.query, ...baseConcepts.filter((c) => c.trim().toLowerCase() !== intent.query)].slice(0, 3)
    : baseConcepts;
  const opening = isOpening ? { concepts, excludedTerms } : undefined;

  const searchVideo = provider.searchVideoCandidates?.bind(provider);
  const searchImage = provider.searchImageCandidates?.bind(provider);

  // Proveedor sin soporte de candidatos múltiples (p. ej. el fixture de
  // desarrollo): usa fetchFootage tal cual, sin puntuar ni diversificar —
  // sigue siendo válido para probar el pipeline sin Pexels, pero no
  // aplica ninguna de las mejoras de esta fase.
  if (!searchVideo && !searchImage) {
    if (isOpening && provider.name !== "fixture") throw new OpeningFootageUnavailableError();
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

  let lastResortVideo: TieredScoredCandidate | undefined;
  // 1) Video, probando cada concepto en orden (el principal primero).
  if (searchVideo) {
    const { scored, totalCandidates } = await collectScored(
      effectiveConcepts,
      (query) => searchVideo(query, minimumDurationSeconds).then((c) => c ?? []),
      minimumDurationSeconds,
      state,
      opening,
      intent,
    );
    const ranked = rankTiered(isOpening ? scored.filter(c => c.score >= MIN_ACCEPTABLE_SCORE) : scored);
    const best = ranked.find((c) => acceptable(c, intent));
    lastResortVideo = ranked.find((c) => c.technicalScore >= MIN_ACCEPTABLE_SCORE && !c.contradicted)
      ?? ranked.find((c) => c.technicalScore >= MIN_ACCEPTABLE_SCORE);
    if (best) {
      return commit(best, state, false, totalCandidates, intent);
    }

    // 2) Reformular el concepto principal y reintentar solo video, una vez.
    const fallbackQuery = isOpening ? openingFallbackQuery(concepts) : buildFallbackQuery(baseConcepts[0], intent);
    const fallback = await collectScored(
      fallbackQuery ? [fallbackQuery] : [],
      (query) => searchVideo(query, minimumDurationSeconds).then((c) => c ?? []),
      minimumDurationSeconds,
      state,
      opening,
      intent,
    );
    const fallbackRanked = rankTiered(isOpening ? fallback.scored.filter(c => c.score >= MIN_ACCEPTABLE_SCORE) : fallback.scored);
    const fallbackBest = fallbackRanked.find((c) => acceptable(c, intent));
    const fallbackResort = fallbackRanked.find((c) => c.technicalScore >= MIN_ACCEPTABLE_SCORE && !c.contradicted)
      ?? fallbackRanked.find((c) => c.technicalScore >= MIN_ACCEPTABLE_SCORE);
    if (fallbackResort && (!lastResortVideo ||
      (lastResortVideo.contradicted && !fallbackResort.contradicted) ||
      (lastResortVideo.contradicted === fallbackResort.contradicted && fallbackResort.score > lastResortVideo.score))) lastResortVideo = fallbackResort;
    if (fallbackBest) {
      console.warn(
        `[atomivid:footage] fallback de consulta: "${effectiveConcepts[0]}" → "${fallbackQuery}" ` +
          `(ningún candidato de video superó el umbral con los conceptos originales)`,
      );
      return commit(fallbackBest, state, true, fallback.totalCandidates, intent);
    }
  }

  // 3) Último recurso: imagen, con los conceptos originales.
  let lastResortImage: TieredScoredCandidate | undefined;
  if (searchImage) {
    const { scored, totalCandidates } = await collectScored(
      effectiveConcepts,
      (query) => searchImage(query),
      minimumDurationSeconds,
      state,
      opening,
      intent,
    );
    const ranked = rankTiered(isOpening ? scored.filter(c => c.score >= MIN_ACCEPTABLE_SCORE) : scored);
    const best = isOpening || !intent ? ranked[0] : ranked.find((c) => acceptable(c, intent));
    lastResortImage = ranked.find((c) => !c.contradicted) ?? ranked[0];
    if (best && (!isOpening || best.score >= MIN_ACCEPTABLE_SCORE)) {
      console.warn(
        `[atomivid:footage] sin video aprovechable para [${effectiveConcepts.join(" | ")}] — se usa una imagen`,
      );
      return commit(best, state, true, totalCandidates, intent);
    }
  }

  // Exhaust the bounded search before a compatibility fallback. Prefer an
  // unverified/weak match to an explicit contradiction, regardless of media type.
  const lastResort = [lastResortVideo, lastResortImage].find((c) => c && !c.contradicted)
    ?? lastResortVideo ?? lastResortImage;
  if (!isOpening && lastResort) {
    console.warn(`[atomivid:footage] sin coincidencia suficiente en metadatos para [${effectiveConcepts.join(" | ")}] — respaldo técnico sin pertinencia comprobada`);
    return commit({ ...lastResort, facets: [] }, state, true, 0, intent);
  }
  if (isOpening) throw new OpeningFootageUnavailableError();
  throw new FootageSelectionError(effectiveConcepts);
}
