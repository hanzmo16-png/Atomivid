import type { FootageCandidate } from "@/lib/providers/types";

/** Provider-description gate, NOT a visual/semantic model. Never treats search
 * rank, the search query itself, or HD resolution as evidence of clip content. */
export type OpeningRelevance = {
  mode: "provider_metadata"; visualInspection: false;
  accepted: boolean; matchedTerms: string[]; reason: string;
};
const WEAK = new Set(("a an the of and or to in on at by for with from near is are " +
  "person people man men woman women someone adult young old creator content video " +
  "looking looks look showing shows show using uses use close up closeup portrait vertical " +
  "frustrated frustration confused confusion happy sad angry emotion emotional feeling face facial " +
  "beautiful attractive amazing dramatic cinematic high quality footage stock b roll").split(" "));
const ALIASES: Record<string, string> = {
  smartphone: "phone", smartphones: "phone", cellphone: "phone", cellphones: "phone", iphone: "phone", phones: "phone",
  filming: "record", filmed: "record", recording: "record", records: "record", vlogging: "record", vlogger: "record",
  cameras: "camera", vegetables: "vegetable", cooking: "cook", chopping: "chop", runners: "runner", running: "run",
};
const rawTerms = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-z]+/g) ?? [];
const terms = (s: string) => [...new Set(rawTerms(s).filter(t => t.length > 2 && !WEAK.has(t)).map(t => ALIASES[t] ?? t))];
const REACTIONS = [/\bscream(?:ing|s)?\b/, /\byell(?:ing|s)?\b/, /\bgrimac(?:e|es|ing)\b/, /\bfunny faces?\b/, /\bmaking faces\b/];

export function assessOpeningRelevance(candidate: FootageCandidate, concepts: string[], excludedTerms: string[] = []): OpeningRelevance {
  const result = (accepted: boolean, matchedTerms: string[], reason: string): OpeningRelevance =>
    ({ mode: "provider_metadata", visualInspection: false, accepted, matchedTerms, reason });
  const description = candidate.description?.trim();
  if (!description) return result(false, [], "descripción del proveedor ausente; contenido sin comprobar");
  const candidateRaw = rawTerms(description).join(" ");
  const intendedRaw = rawTerms(concepts.join(" ")).join(" ");
  for (const reaction of REACTIONS) if (reaction.test(candidateRaw) && !reaction.test(intendedRaw))
    return result(false, [], "reacción exagerada no solicitada en la apertura");
  for (const excluded of excludedTerms) {
    const phrase = rawTerms(excluded).join(" ");
    if (phrase && ` ${candidateRaw} `.includes(` ${phrase} `)) return result(false, [], "contenido excluido por el guion");
  }
  const groups = concepts.map(terms).filter(g => g.length);
  if (!groups.length) return result(false, [], "la apertura necesita un objeto o actividad concretos");
  const available = new Set(terms(description));
  const matched = [...new Set(groups.flat().filter(t => available.has(t)))];
  // An object/activity shared by every alternative is the invariant intent.
  // E.g. all three approved concepts mention phone; 'frustrated man' cannot qualify.
  const shared = groups[0].filter(t => groups.every(g => g.includes(t)));
  if (shared.length && !shared.some(t => available.has(t))) return result(false, matched, "falta el objeto o actividad común de la apertura");
  if (!matched.length) return result(false, [], "sin coincidencia concreta con la apertura");
  return result(true, matched, `coincidencia en descripción del proveedor: ${matched.join(", ")} (sin inspección visual)`);
}

/** Drop generic people/emotions, preserving subject/activity instead of keeping
 * the first two words (which turned 'person frustrated phone recording' into 'person frustrated'). */
export function openingFallbackQuery(concepts: string[]): string | null {
  for (const concept of concepts) {
    const concrete = rawTerms(concept).filter(t => t.length > 2 && !WEAK.has(t));
    if (concrete.length) return concrete.slice(0, 5).join(" ");
  }
  return null;
}

export class OpeningFootageUnavailableError extends Error {
  readonly customerMessage = "No encontramos una toma inicial con suficiente relación con el tema. Tu guion y los recursos ya guardados se conservan. Revisa el concepto visual de la primera escena antes de reintentar.";
  constructor() { super("OPENING_FOOTAGE_UNVERIFIED"); this.name = "OpeningFootageUnavailableError"; }
}
