/**
 * Selección de material de archivo por escena (calidad visual M1).
 *
 * Reemplaza el patrón anterior del ejecutor (`candidates[0]` de la primera
 * búsqueda y, si fallaba, una búsqueda por el TEMA general aceptada sin
 * mirar su contenido):
 *
 * - Consultas por niveles de la MISMA intención: descripción → alternativas
 *   declaradas → sujeto+lugar. Nunca el tema del documental por sí solo.
 * - Pertinencia por PALABRAS CLAVE entre la intención (sujeto, acción,
 *   lugar, época) y el texto que el proveedor da del recurso (alt de la
 *   foto / slug de la página del video). Es una comprobación léxica, NO
 *   semántica: no ve la imagen. Se reporta como tal ("keyword_match"), y un
 *   candidato sin texto descriptivo queda "unverified" (incierto).
 * - Contradicciones explícitas: época (p. ej. teléfonos o contenedores en
 *   una escena de 1910) y lugar (otro país/ciudad nombrado) → se descarta.
 * - Deduplicación global contra el registro del documental: id del
 *   proveedor y URL canónica ANTES de descargar; SHA-256 y hash perceptual
 *   DESPUÉS de descargar.
 * - Sin candidato pertinente y único → CARENCIA explícita (con motivos),
 *   nunca material ajeno en silencio.
 */
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";
import { requiresEvidence, requiresIdentity, type BeatVisual } from "./visual-intents";
import { canonicalizeUrl, contentIdentity, type AssetIdentity, type DocumentAssetRegistry, type DuplicateMatch } from "./asset-identity";

const EN_STOPWORDS = new Set(
  "a an the of and or to in on at by for with from into over under near is are was were be been being this that these those it its as up down out off some many few more most very large small big little old new".split(
    " ",
  ),
);

/** Marcadores de época moderna que contradicen una escena histórica (≤ 1950). */
const MODERN_MARKERS = [
  "smartphone", "phone", "iphone", "laptop", "computer", "tablet", "drone", "car", "cars", "traffic", "highway", "skyscraper", "skyscrapers",
  "modern", "neon", "office", "airplane", "jet", "container", "containers", "electric", "led", "screen", "selfie", "suv", "truck", "trucks",
  "headphones", "wifi", "instagram",
];

/** Lugares nombrados que, si el candidato los menciona y la intención nombra OTRO, delatan un contexto geográfico ajeno. */
const KNOWN_PLACES = [
  "panama", "egypt", "suez", "paris", "france", "london", "england", "new york", "usa", "america", "china", "japan", "india", "dubai",
  "italy", "rome", "venice", "spain", "mexico", "brazil", "canada", "germany", "russia", "turkey", "istanbul", "greece", "singapore",
  "hong kong", "australia", "thailand", "vietnam", "netherlands", "amsterdam", "hamburg", "rotterdam", "miami", "los angeles", "san francisco",
  "barbados", "jamaica", "colombia", "caribbean",
];

export type Relevance = "keyword_match" | "unverified" | "irrelevant";

export type RelevanceAssessment = {
  relevance: Relevance;
  score: number;
  matchedTerms: string[];
  conflicts: string[];
};

function stem(word: string): string {
  return word.replace(/(ing|ers|er|es|s)$/i, "");
}

export function englishTerms(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || EN_STOPWORDS.has(raw)) continue;
    const s = stem(raw);
    if (s.length >= 3 && !out.includes(s)) out.push(s);
  }
  return out;
}

function isHistoricalEra(era: string | undefined): boolean {
  if (!era) return false;
  const year = /\b(1[5-9]\d\d)/.exec(era);
  if (year) return Number(year[1]) <= 1950;
  return /(century|historic|ancient|vintage|colonial|19th|18th|17th|1[5-9]\d0s)/i.test(era);
}

/** Pertinencia léxica de un candidato frente a la intención de la escena. */
export function assessRelevance(visual: BeatVisual, candidateText: string | undefined): RelevanceAssessment {
  if (!candidateText || !candidateText.trim() || visual.derived) return { relevance: "unverified", score: 0, matchedTerms: [], conflicts: [] };
  const text = candidateText.toLowerCase();
  const candidate = new Set(englishTerms(candidateText));
  const conflicts: string[] = [];
  if (isHistoricalEra(visual.era)) {
    for (const marker of MODERN_MARKERS) if (new RegExp(`\\b${marker}\\b`).test(text)) conflicts.push(`época: "${marker}"`);
  }
  const place = visual.place?.toLowerCase();
  if (place) {
    for (const other of KNOWN_PLACES) {
      if (!place.includes(other) && !other.includes(place) && new RegExp(`\\b${other}\\b`).test(text)) conflicts.push(`lugar: "${other}"`);
    }
  }
  const matched: string[] = [];
  let score = 0;
  const weigh = (terms: string[], weight: number) => {
    for (const t of terms) {
      if (candidate.has(t) && !matched.includes(t)) {
        matched.push(t);
        score += weight;
      }
    }
  };
  const subject = englishTerms(visual.subject);
  weigh(subject, 3);
  weigh(englishTerms(visual.action), 2);
  weigh(englishTerms(visual.place), 2);
  weigh(englishTerms(visual.description), 1);
  const hasCore = subject.length > 0 ? subject.some((t) => candidate.has(t)) : matched.length > 0;
  const relevance: Relevance = conflicts.length === 0 && hasCore && score >= 2 ? "keyword_match" : "irrelevant";
  return { relevance, score, matchedTerms: matched, conflicts };
}

/** Consultas por niveles de la MISMA intención — nunca el tema del documental solo. */
export function selectionQueries(visual: BeatVisual): string[] {
  if (visual.identity) {
    // Con identidad exigida la acción/transición (subir, entrar, caminar) no
    // busca nada: solo trae cuerpos anónimos haciéndola. Se busca a la
    // persona en su lugar y época; la descripción y las alternativas, que
    // narran la acción, no se usan.
    const name = visual.identity.name;
    return [...new Set([[name, visual.place, visual.era], [name, visual.place], [name]].map((q) => q.filter(Boolean).join(" ").trim()).filter(Boolean))];
  }
  if (visual.beatClass === "TRANSITION") {
    // Una transición (v4) no convierte el verbo narrado en material literal:
    // se busca su sujeto en su lugar y época, nunca la acción ni la descripción.
    return [...new Set([[visual.subject, visual.place, visual.era], [visual.subject, visual.place]].map((q) => q.filter(Boolean).join(" ").trim()).filter(Boolean))];
  }
  const queries = [visual.description, ...(visual.alternates ?? [])];
  if (visual.subject) queries.push([visual.subject, visual.place].filter(Boolean).join(" "));
  return [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
}

export type RejectedCandidate = { sourceId?: string; query: string; reason: string };

/** Reutilización justificada de un recurso VERIFICADO para la misma identidad/proposición (nunca genérica). */
export type SelectionReuse = { of: string; justification: "verified_identity_reuse" | "verified_evidence_reuse" };

/** Términos de la acción de la persona del beat que aparecen en el candidato (solo escenas de contexto v4). */
export function personSubstitute(visual: BeatVisual, candidateText: string | undefined): string | null {
  if (!visual.personActions || visual.personActions.length === 0 || !candidateText) return null;
  const actions = new Set(englishTerms(visual.personActions.join(" ")));
  const hits = englishTerms(candidateText).filter((t) => actions.has(t));
  return hits.length > 0 ? hits.join(", ") : null;
}

/** Vínculo de entidad confirmado por el servidor (nunca por el texto del candidato). */
export type TrustedEntityLink = { name: string };
/** Fuentes que el servidor confirma que el recurso documenta (nunca por su texto, su URL ni su tipo de objeto). */
export type TrustedEvidenceLink = { sourceIds: string[] };

/**
 * Filtro duro de PRUEBA (v4): una escena EVIDENCE solo admite un recurso que el
 * verificador del servidor vincula a la MISMA proposición (sus fuentes). La
 * similitud nomina; nunca prueba: un periódico sobre otro hecho comparte el
 * objeto ("newspaper"), no la proposición.
 */
export function evidenceEligibility(
  visual: BeatVisual,
  link: TrustedEvidenceLink | null,
): { eligible: true; link?: TrustedEvidenceLink } | { eligible: false; why: string } {
  if (!requiresEvidence(visual)) return { eligible: true };
  if (!visual.evidence) return { eligible: false, why: "EVIDENCE sin proposición declarada" };
  if (!link) return { eligible: false, why: `sin vínculo de prueba de confianza con la proposición (${visual.evidence.sourceIds.join(", ")})` };
  const required = new Set(visual.evidence.sourceIds);
  if (!link.sourceIds.some((id) => required.has(id))) return { eligible: false, why: `documenta otro hecho (${link.sourceIds.join(", ")}), no la proposición (${visual.evidence.sourceIds.join(", ")})` };
  return { eligible: true, link };
}

function sameIdentity(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

/**
 * Filtro duro de identidad (previo a cualquier aprobación por pertinencia).
 * Con identidad exigida, solo es ELEGIBLE un candidato cuyo vínculo con esa
 * misma persona confirma el verificador del servidor. Descripción, alt
 * text, `entityReference` y orden del proveedor son afirmaciones, no
 * pruebas: un humano genérico, una parte del cuerpo, una profesión, un
 * homónimo o un nombre auto-declarado quedan fuera sin importar su score.
 * Hoy ningún proveedor aporta metadata estructurada "sin personas", así
 * que el contexto no humano tampoco es elegible aquí: sin vínculo, carencia.
 */
export function identityEligibility(
  visual: BeatVisual,
  link: TrustedEntityLink | null,
): { eligible: true; link?: TrustedEntityLink } | { eligible: false; why: string } {
  if (!requiresIdentity(visual)) return { eligible: true };
  if (!visual.identity) return { eligible: false, why: visual.classificationGap ? "CLASSIFICATION_INTEGRITY_GAP" : "escena IDENTITY sin identidad válida" };
  if (!link) return { eligible: false, why: `sin vínculo de confianza con ${visual.identity.name}` };
  if (!sameIdentity(link.name, visual.identity.name)) return { eligible: false, why: `vinculado a otra entidad (${link.name}), no a ${visual.identity.name}` };
  return { eligible: true, link };
}

export type StockSelection = {
  status: "selected";
  candidate: FootageCandidate;
  buffer: Buffer;
  identity: AssetIdentity;
  query: string;
  tier: number;
  assessment: RelevanceAssessment;
  /** Presente cuando la escena exige identidad: el vínculo de confianza que la habilitó. */
  entityLink?: TrustedEntityLink;
  /** Presente cuando la escena es EVIDENCE: el vínculo de prueba de confianza que la habilitó. */
  evidenceLink?: TrustedEvidenceLink;
  /** Presente si el recurso ya ocupa otra escena: reutilización verificada y justificada. */
  reuse?: SelectionReuse;
  candidatesConsidered: number;
  rejected: RejectedCandidate[];
};

export type StockGap = {
  status: "gap";
  reason: string;
  queries: string[];
  candidatesConsidered: number;
  rejected: RejectedCandidate[];
};

export type StockSelectionDeps = {
  footageProvider: FootageProvider;
  registry: DocumentAssetRegistry;
  /** Inyectable en pruebas (evita ffmpeg/sharp). */
  identify?: (buffer: Buffer, mediaType: "image" | "video") => Promise<Pick<AssetIdentity, "sha256" | "dhash" | "dhashUnavailable">>;
  /** Tope de descargas por escena (cada descarga rechazada cuesta tiempo, no dinero). */
  maxDownloads?: number;
  /**
   * Verificador de vínculos de entidad controlado por el servidor (p. ej. el
   * catálogo de un archivo de confianza). Es la ÚNICA fuente de confianza
   * de identidad. Sin él (producción hoy), ningún candidato está vinculado.
   */
  verifyEntityLink?: (candidate: FootageCandidate, providerName: string) => TrustedEntityLink | null;
  /** Verificador de pruebas del servidor (archivo/registro de confianza). Ausente hoy: ningún recurso prueba una proposición. */
  verifyEvidenceLink?: (candidate: FootageCandidate, providerName: string) => TrustedEvidenceLink | null;
};

function describeDuplicate(match: DuplicateMatch): string {
  const what = { sourceId: "mismo id del proveedor", canonicalUrl: "misma URL canónica", sha256: "mismo contenido (SHA-256)", dhash: "imagen casi idéntica (hash perceptual)" }[match.key];
  return `duplicado de ${match.shotId}: ${what}${match.distance !== undefined ? ` (distancia ${match.distance})` : ""}`;
}

async function candidatesFor(provider: FootageProvider, query: string, preferVideo: boolean, minDurationSec: number): Promise<FootageCandidate[]> {
  const out: FootageCandidate[] = [];
  if (preferVideo && provider.searchVideoCandidates) out.push(...(await provider.searchVideoCandidates(query, minDurationSec, "landscape").catch(() => [])));
  if (provider.searchImageCandidates) out.push(...(await provider.searchImageCandidates(query, "landscape").catch(() => [])));
  if (out.length === 0 && !provider.searchVideoCandidates && !provider.searchImageCandidates) {
    // Proveedor sin búsqueda de candidatos (fixture): un único resultado, sin id estable.
    const single = await provider.fetchFootage(query, preferVideo ? minDurationSec : undefined, "landscape").catch(() => null);
    if (single) out.push({ ...single, sourceId: "" });
  }
  return out;
}

export async function selectStockForShot(
  input: { shotId: string; visual: BeatVisual; preferVideo: boolean; minDurationSec: number },
  deps: StockSelectionDeps,
): Promise<StockSelection | StockGap> {
  if (requiresIdentity(input.visual) && !input.visual.identity) {
    // Fail-closed (v4): IDENTITY sin persona declarada, o clasificación incierta, no busca material de ningún tipo.
    const reason = input.visual.classificationGap ? "CLASSIFICATION_INTEGRITY_GAP: clasificación incierta, no se busca material" : "PLANNING_FAILURE: escena IDENTITY sin identidad válida, no se busca material";
    return { status: "gap", reason, queries: [], candidatesConsidered: 0, rejected: [] };
  }
  if (requiresEvidence(input.visual) && !input.visual.evidence) {
    return { status: "gap", reason: "PLANNING_FAILURE: escena EVIDENCE sin proposición declarada, no se busca material", queries: [], candidatesConsidered: 0, rejected: [] };
  }
  const queries = selectionQueries(input.visual);
  const identify = deps.identify ?? contentIdentity;
  const maxDownloads = deps.maxDownloads ?? 6;
  const rejected: RejectedCandidate[] = [];
  const seen = new Set<string>();
  let considered = 0;
  let downloads = 0;
  for (const [tier, query] of queries.entries()) {
    const candidates = await candidatesFor(deps.footageProvider, query, input.preferVideo, input.minDurationSec);
    for (const candidate of candidates) {
      const reference: AssetIdentity = {
        provider: deps.footageProvider.name,
        sourceId: candidate.sourceId || undefined,
        canonicalUrl: canonicalizeUrl(candidate.url),
      };
      const key = reference.sourceId ?? reference.canonicalUrl ?? candidate.url;
      if (seen.has(key)) continue;
      seen.add(key);
      considered += 1;
      const identity = identityEligibility(input.visual, deps.verifyEntityLink?.(candidate, deps.footageProvider.name) ?? null);
      const evidenceVerdict = evidenceEligibility(input.visual, deps.verifyEvidenceLink?.(candidate, deps.footageProvider.name) ?? null);
      // Reutilización legítima (v4): SOLO un recurso con vínculo verificado que coincide con la identidad/proposición
      // de ESTA escena. Cualquier otra repetición sigue rechazándose.
      const verifiedReuse: SelectionReuse["justification"] | null =
        identity.eligible && identity.link ? "verified_identity_reuse" : evidenceVerdict.eligible && evidenceVerdict.link ? "verified_evidence_reuse" : null;
      let reuse: SelectionReuse | undefined;
      const refDup = deps.registry.findByReference(reference, input.shotId);
      if (refDup) {
        if (!verifiedReuse) {
          rejected.push({ sourceId: reference.sourceId, query, reason: describeDuplicate(refDup) });
          continue;
        }
        reuse = { of: refDup.shotId, justification: verifiedReuse };
      }
      const assessment = assessRelevance(input.visual, candidate.description);
      const substitute = personSubstitute(input.visual, candidate.description);
      if (substitute) {
        // Contexto de un beat con persona: el candidato muestra lo que hace la persona → la sustituiría.
        rejected.push({ sourceId: reference.sourceId, query, reason: `FALSE_FRIEND: muestra la acción de la persona del beat (${substitute}) sin ser ella (pertinencia ${assessment.relevance}, score ${assessment.score}; ${candidate.description})` });
        continue;
      }
      if (!identity.eligible) {
        // El score no se toca: se rechaza A PESAR de su pertinencia léxica.
        const falseFriend = assessment.relevance !== "irrelevant";
        rejected.push({
          sourceId: reference.sourceId,
          query,
          reason: `${falseFriend ? "FALSE_FRIEND" : "IDENTITY_UNVERIFIED"}: ${identity.why} (pertinencia ${assessment.relevance}, score ${assessment.score}; ${candidate.description ?? "sin descripción"})`,
        });
        continue;
      }
      const evidence = evidenceVerdict;
      if (!evidence.eligible) {
        // El score no se toca: mismo objeto/medio no es la misma proposición.
        const falseFriend = assessment.relevance !== "irrelevant";
        rejected.push({
          sourceId: reference.sourceId,
          query,
          reason: `${falseFriend ? "FALSE_FRIEND" : "EVIDENCE_UNGROUNDED"}: ${evidence.why} (pertinencia ${assessment.relevance}, score ${assessment.score}; ${candidate.description ?? "sin descripción"})`,
        });
        continue;
      }
      if (identity.link || evidence.link) {
        // Elegible por identidad/prueba, no aceptado: las contradicciones de época/lugar siguen descartando.
        if (assessment.conflicts.length > 0) {
          rejected.push({ sourceId: reference.sourceId, query, reason: `contradicción ${assessment.conflicts.join(", ")}` });
          continue;
        }
      } else if (assessment.relevance === "irrelevant") {
        rejected.push({
          sourceId: reference.sourceId,
          query,
          reason: assessment.conflicts.length > 0 ? `contradicción ${assessment.conflicts.join(", ")}` : `sin coincidencia con la intención (${candidate.description ?? "sin descripción"})`,
        });
        continue;
      }
      // Sin texto descriptivo solo se acepta desde la consulta principal, y queda como incierto.
      if (!identity.link && !evidence.link && assessment.relevance === "unverified" && tier > 0) {
        rejected.push({ sourceId: reference.sourceId, query, reason: "sin descripción del proveedor en una consulta secundaria" });
        continue;
      }
      if (downloads >= maxDownloads) {
        rejected.push({ sourceId: reference.sourceId, query, reason: "tope de descargas por escena alcanzado" });
        continue;
      }
      downloads += 1;
      let buffer: Buffer;
      try {
        buffer = await deps.footageProvider.downloadFootage(candidate.url);
      } catch (err) {
        rejected.push({ sourceId: reference.sourceId, query, reason: `descarga fallida (${err instanceof Error ? err.message.slice(0, 60) : "error"})` });
        continue;
      }
      if (buffer.byteLength === 0) {
        rejected.push({ sourceId: reference.sourceId, query, reason: "archivo vacío" });
        continue;
      }
      const content = await identify(buffer, candidate.mediaType);
      const contentDup = deps.registry.findByContent(content, input.shotId);
      if (contentDup) {
        if (!verifiedReuse) {
          rejected.push({ sourceId: reference.sourceId, query, reason: describeDuplicate(contentDup) });
          continue;
        }
        reuse ??= { of: contentDup.shotId, justification: verifiedReuse };
      }
      return {
        status: "selected",
        candidate,
        buffer,
        identity: { ...reference, ...content },
        query,
        tier,
        assessment,
        ...(identity.link ? { entityLink: identity.link } : {}),
        ...(evidence.link ? { evidenceLink: evidence.link } : {}),
        ...(reuse ? { reuse } : {}),
        candidatesConsidered: considered,
        rejected,
      };
    }
  }
  const duplicates = rejected.filter((r) => r.reason.startsWith("duplicado")).length;
  const irrelevant = rejected.length - duplicates;
  return {
    status: "gap",
    reason:
      considered === 0
        ? "el proveedor no devolvió candidatos para esta intención"
        : `sin candidato pertinente y único (${considered} evaluados: ${duplicates} ya usados en el documental, ${irrelevant} no pertinentes o fallidos)`,
    queries,
    candidatesConsidered: considered,
    rejected,
  };
}
