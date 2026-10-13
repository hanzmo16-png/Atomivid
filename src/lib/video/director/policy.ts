/**
 * Documentary policy (documentary-policy@1): the visual bible v1 (content/long-form/atomivid-long-form-visual-bible-v1.md)
 * made operable for each narrative unit. Deterministic and conservative: storyboard metadata and script claims
 * take precedence; a lexicon match can only ALERT or restrict, it never approves anything by itself.
 * Used by propose.ts (to decide) and by audit.ts (to recompute and never trust what a plan says).
 */
import { DOCUMENTARY_POLICY_VERSION, type DirectorInput, type InventoryAsset, type POLICY_CLASSES, type VISUAL_TYPES } from "./contract";

export type PolicyClass = (typeof POLICY_CLASSES)[number];
export type VisualType = (typeof VISUAL_TYPES)[number];
type Segment = DirectorInput["segments"][number];

const STOP = new Set("a al algo ante con de del el en es esa ese eso esta este la las lo los mas más no o para pero por que qué se sin sobre su sus un una uno y ya the of and to".split(" "));
export const normalize = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
export const words = (t: string) => normalize(t).split(/[^a-z0-9ñ]+/).filter(w => w.length > 2 && !STOP.has(w));

/**
 * Topic lexicon over normalised text. It is a vocabulary match, not comprehension: every decision that uses it
 * says so ("lexicon" source). "huesos" alone is deliberately NOT human remains, and plant remains never are.
 */
export const TOPIC_LEXICON: Record<string, RegExp> = {
  remains: /\brestos humanos\b|\bcraneos?\b|\besqueletos?\b|\benterramientos?\b|\btumbas?\b|\bcadaver(es)?\b|\bhuesos humanos\b/,
  pillar: /\bpilar(es)?\b|\bmonolitos?\b|\bforma de t\b/,
  structure: /\brecintos?\b|\bestructuras?\b|\bmuros?\b|\bviviendas?\b|\bcasas?\b|\btemplos?\b|\bsantuarios?\b|\bconstruccion(es)?\b|\bedificios?\b|\bmonumental(es)?\b/,
  relief: /\brelieves?\b|\btallad[oa]s?\b|\bgrabad[oa]s?\b|\bzorros?\b|\bjabalies\b|\bjabali\b|\bserpientes?\b|\baves\b|\bsimbolos?\b|\bfigura humana\b/,
  landscape: /\bpaisajes?\b|\bcolinas?\b|\bmontanas?\b|\bvalles?\b|\bllanuras?\b|\bcima\b|\bhorizonte\b|\bregion(es)?\b|\bterritorio\b|\bamanecer\b|\batardecer\b|\bmeseta\b/,
  geo: /\bturquia\b|\banatolia\b|\bsanl.?urfa\b|\bgermus\b|\bmapas?\b|\bsureste\b|\bkilometros?\b|\bal norte\b|\bal sur\b|\bnucleo protegido\b/,
  chrono: /\b\d{3,5}\b|\bsiglos?\b|\bmilenios?\b|\bmil anos\b|\bantes de nuestra era\b|\bneolitico\b|\bpreceramico\b|\bceramica\b|\bperiodo\b|\bcronologia\b|\bfechas?\b|\banos atras\b/,
  data: /\b\d+([.,]\d+)?\b|\bmetros?\b|\btoneladas?\b|\bcifras?\b|\bpor ciento\b|\bkilos?\b/,
  people: /\bcazadores\b|\brecolectores\b|\bcomunidad(es)?\b|\bpersonas\b|\bgente\b|\bgrupos?\b|\bsociedad(es)?\b|\bcooper\w*/,
  hands_work: /\btallar\w*|\bherramientas?\b|\btrabaj\w*|\bconstruir\b|\blevantar\w*|\boficios?\b|\btecnicas?\b|\bmoler\b|\bmolienda\b|\btransport\w*|\barrastr\w*/,
  excavation: /\bexcavac\w*|\barqueolog\w*|\bexcavad\w*|\bequipo de excavacion\b|\bcampanas? de excavacion\b|\bhallazgos?\b|\bdescubri\w*/,
  artifact: /\bartefactos?\b|\bpiedras? de moler\b|\bmorteros?\b|\bobjetos?\b|\bvasijas?\b|\bcuchillas?\b|\bpuntas? de flecha\b|\bherramientas de piedra\b/,
  food: /\bcereal(es)?\b|\btrigo\b|\bgranos?\b|\balimentos?\b|\bfitolitos?\b|\bplantas?\b|\bcerveza\b|\bgachas\b/,
  research: /\bestudios?\b|\bpublica\w*|\bfuentes?\b|\bverific\w*|\bconfirm\w*|\binvestigador\w*|\banalisis\b|\barticulos?\b|\brevistas?\b|\bdoi\b/,
};
/** Alert-only vocabulary: reported as a signal, never escalates the policy class. */
const ALERT_ONLY: Record<string, RegExp> = { hueso: /\bhuesos?\b/ };
const NEGATION = /\bno (fue|es|era|se|pudimos|pudo|sabemos|existe|existen|hay|encaja|sostiene|consta)\b|\bnunca\b|\bsin confirmar\b|\bno confirmad\w*/;
const HEDGE = /\bpodrian?\b|\bposibles?\b|\bquizas?\b|\btal vez\b|\bprobablemente\b|\bhasta donde\b|\bse habria\b|\bhabria\b|\bparecen?\b|\bhipotesis\b|\bsupuest\w*/;

export function topicsOf(text: string): string[] {
  const t = normalize(text);
  return Object.entries(TOPIC_LEXICON).filter(([, re]) => re.test(t)).map(([k]) => k);
}

const SPECIFIC = ["pillar", "relief", "structure", "artifact"];
const MEASURABLE = ["chrono", "geo", "data"];

/** Topics of an inventory asset: editorial metadata when present, otherwise its tags through the same lexicon. */
export function assetTopics(a: InventoryAsset): string[] {
  if (a.content?.topics.length) return a.content.topics;
  return topicsOf(a.tags.filter(t => !t.includes(":")).join(" "));
}

/** Coarse visual type of an asset: declared, else inferred from kind/provenance/topics. */
export function assetVisualType(a: InventoryAsset): VisualType {
  if (a.content?.visualType) return a.content.visualType;
  if (a.kind === "text") return "text";
  if (a.kind === "graphic" || a.provenance === "data_graphic") return "diagram";
  return visualFromTopics(assetTopics(a));
}

/** The visual type a NEW image for a unit would have (only used for generic, non-evidential material). */
export function visualFromTopics(topics: string[]): VisualType {
  const order: [string, VisualType][] = [["remains", "remains"], ["pillar", "structure"], ["structure", "structure"], ["relief", "relief"], ["artifact", "artifact"],
    ["excavation", "excavation"], ["hands_work", "hands_work"], ["people", "people"], ["landscape", "landscape"], ["geo", "landscape"]];
  return order.find(([t]) => topics.includes(t))?.[1] ?? "concept";
}

export type UnitPolicy = {
  version: string; class: PolicyClass; sources: ("storyboard" | "script_claims" | "lexicon" | "default")[];
  signals: string[]; status: "ok" | "review_required";
  /** The unit carries an unverified claim, a negation or a hedge. */
  unconfirmed: boolean;
};

const segAssets = (input: DirectorInput, seg: Segment) => input.inventory.filter(a => a.tags.includes(`segment:${seg.id}`));

/**
 * The script claim a unit belongs to: most shared content words, with years as strong keys (a unit naming 2017
 * belongs to the 2017 claim, not to a 2026 rumour). Needs 3 shared words, or 30% of a short unit (min 2).
 */
export function claimFor(seg: Segment, unit: string) {
  const u = new Set(words(unit)), years = new Set(unit.match(/\b\d{4}\b/g) ?? []);
  const need = Math.max(2, Math.min(3, Math.ceil(u.size * 0.3)));
  let best: { claim: Segment["claims"][number]; score: number } | undefined;
  for (const c of seg.claims) {
    const shared = words(c.text).filter(w => u.has(w)).length;
    const cy = new Set(c.text.match(/\b\d{4}\b/g) ?? []);
    const yearHit = [...years].some(y => cy.has(y)), yearClash = years.size > 0 && cy.size > 0 && !yearHit;
    if (yearClash || shared < need) continue;
    const score = shared + (yearHit ? 3 : 0);
    // Ties go to the less certain claim (conservative).
    if (!best || score > best.score || (score === best.score && c.support === "unverified")) best = { claim: c, score };
  }
  return best?.claim;
}

/** Policy of one narrative unit (the anchor) of a segment. Most restrictive class wins. */
export function unitPolicy(input: DirectorInput, seg: Segment, unit: string): UnitPolicy {
  const topics = topicsOf(unit), planned = segAssets(input, seg), norm = normalize(unit);
  const signals: string[] = [];
  const sources = new Set<UnitPolicy["sources"][number]>();
  let status: UnitPolicy["status"] = "ok";
  for (const [k, re] of Object.entries(ALERT_ONLY)) if (re.test(norm) && !topics.includes("remains")) signals.push(`alerta léxica «${k}»: no cambia la política por sí sola`);
  if (/\brestos de plantas\b|\brestos vegetales\b/.test(norm)) signals.push("«restos de plantas» no son restos humanos");
  // Unconfirmed = an unverified script claim, a negation or a hedge. It travels with every class.
  // A hedge inside a SOURCED claim is the source's own wording about an attested finding: signal, not downgrade.
  const claim = claimFor(seg, unit), negation = NEGATION.test(norm), hedge = HEDGE.test(norm);
  const unverified = claim?.support === "unverified";
  const unconfirmed = unverified || negation || (hedge && claim?.support !== "sourced");
  if (claim) { sources.add("script_claims"); signals.push(`afirmación del guion ${claim.id}: ${claim.support}`); }
  if (negation) { sources.add("lexicon"); signals.push("negación: conservar el matiz, no ilustrar como confirmación"); }
  if (hedge) { sources.add("lexicon"); signals.push(claim?.support === "sourced" ? "matiz de la propia fuente sobre un hallazgo documentado: conservarlo en texto o narración" : "matiz/hipótesis: la imagen no puede sugerir más certeza que el texto"); }
  const out = (cls: PolicyClass, extra: UnitPolicy["sources"] = []): UnitPolicy =>
    ({ version: DOCUMENTARY_POLICY_VERSION, class: cls, sources: [...new Set([...sources, ...extra])], signals, status, unconfirmed });

  if (topics.includes("remains")) {
    const sb = planned.some(a => assetTopics(a).includes("remains") && (a.content?.sensitivity === "high" || a.content?.bibleClass === "TEXT" || a.content?.bibleClass === "REAL_DOCUMENTARY" || a.content?.bibleClass === "DETERMINISTIC"));
    if (sb) signals.push("el storyboard trata este beat como restos humanos (sensibilidad alta)");
    else { status = "review_required"; signals.push("restos humanos detectados solo por léxico: confirmar con revisión humana"); }
    if (unconfirmed) signals.push("restos humanos en una afirmación no confirmada: solo tarjeta de texto, nunca una imagen de restos");
    return out("human_remains", sb ? ["lexicon", "storyboard"] : ["lexicon"]);
  }
  const specific = topics.filter(t => SPECIFIC.includes(t));
  if (specific.length) {
    const backing = planned.filter(a => assetTopics(a).some(t => specific.includes(t))
      && (["REAL_DOCUMENTARY", "DETERMINISTIC", "TEXT"].includes(a.content?.bibleClass ?? "") || a.content?.sensitivity === "high" || a.content?.sensitivity === "medium"));
    if (backing.length) {
      signals.push(`evidencia específica (${specific.join(", ")}) respaldada por el storyboard: ${backing.map(a => a.id).join(", ")}`);
      return out("specific_evidence", ["storyboard", "lexicon"]);
    }
    signals.push(`tema específico (${specific.join(", ")}) sin respaldo del storyboard: alerta, no se escala la política`);
  }
  // A figure inside an unverified or negated statement is not a datum to chart: hypothesis first.
  const measurable = topics.filter(t => MEASURABLE.includes(t));
  if (measurable.length && !unverified && !negation) {
    const sb = planned.some(a => ["map", "timeline", "diagram", "text"].includes(assetVisualType(a)) && assetTopics(a).some(t => MEASURABLE.includes(t)));
    signals.push(`dato medible (${measurable.join(", ")}): mapa, línea de tiempo, diagrama o tarjeta`);
    return out("measurable_data", sb ? ["lexicon", "storyboard"] : ["lexicon"]);
  }
  if (measurable.length) signals.push(`cifra/fecha (${measurable.join(", ")}) dentro de una afirmación no verificada o negada: no se representa como dato`);
  if (unconfirmed) return out("hypothesis");
  return { version: DOCUMENTARY_POLICY_VERSION, class: "atmosphere", sources: ["default"], signals, status, unconfirmed: false };
}

export type Treatment = { provenance: InventoryAsset["provenance"]; visual: VisualType; isNew: boolean; plannedForSegment: boolean; topicMatch: boolean; neutral: boolean; showsRemains?: boolean };

/**
 * Whether a treatment respects the unit policy. `review` = allowed only pending human confirmation.
 * New AI material is never allowed to stand in for evidence, remains or measurable data.
 */
/**
 * Reels only: the storyboard derives each planned stock asset from that sentence's own visual concepts, so a planned
 * illustrative stock asset whose window covers the shot corresponds to its sentence by construction (and it is drawn
 * with the visible «ilustrativa» label). Documentaries keep the topic-match requirement; AI recreations never qualify.
 * Shared by the planner and the gate so both decide the same way.
 */
export function reelPlannedStockCorresponds(genre: string, a: InventoryAsset, seg: { id: string; start: number; end: number }, start: number, end: number): boolean {
  if (genre !== "reel" || a.provenance !== "stock_illustrative" || !a.tags.includes(`segment:${seg.id}`)) return false;
  const w = a.content?.window;
  if (!w || w.segmentId !== seg.id) return false;
  const len = seg.end - seg.start, mid = len > 0 ? ((start + end) / 2 - seg.start) / len : 0;
  return mid >= w.from - 1e-9 && mid <= w.to + 1e-9;
}

/**
 * A text companion carries the nuance of a hypothesis/negation next to its image. In a Reel every sentence is burned
 * in as a subtitle over the image (VerticalReel always draws the captions), so the narration's own words are that
 * companion. Elsewhere it must be an explicit text card planned for the segment. Shared by planner and gate.
 */
export function hasTextCompanionFor(input: { genre: string; inventory: InventoryAsset[] }, segId: string): boolean {
  return input.genre === "reel" || input.inventory.some(a => a.kind === "text" && a.tags.includes(`segment:${segId}`) && a.license !== "NOT_CLEARED");
}

export function treatmentAllowed(p: UnitPolicy, t: Treatment, hasTextCompanion: boolean): { allowed: boolean; review?: string; reason: string } {
  // Material about human remains is never used to illustrate a unit that is not about them (e.g. a rumour).
  if (t.showsRemains && p.class !== "human_remains") return { allowed: false, reason: "material sobre restos humanos solo junto a una frase sobre esos restos" };
  const authentic = t.provenance === "archival_documentary", graphic = t.provenance === "data_graphic";
  const illustrativePlanned = !t.isNew && t.plannedForSegment && t.topicMatch;
  switch (p.class) {
    case "human_remains":
      if (p.unconfirmed) return graphic && t.visual === "text" ? { allowed: true, reason: "tarjeta de texto que conserva el matiz" }
        : { allowed: false, reason: "restos humanos en una afirmación no confirmada: solo tarjeta de texto" };
      if (authentic) return { allowed: true, reason: "evidencia real (licencia aparte)" };
      if (graphic && t.visual === "text") return { allowed: true, reason: "tarjeta de texto" };
      if (graphic) return { allowed: true, review: "biblia: REAL_DOCUMENTARY o TEXT; un diagrama esquemático no fotográfico requiere confirmación humana", reason: "diagrama esquemático" };
      return { allowed: false, reason: "restos humanos: nunca recreación ni material ilustrativo" };
    case "specific_evidence":
      if (authentic || graphic) return { allowed: true, reason: authentic ? "evidencia real" : "gráfico/tarjeta determinista" };
      if (illustrativePlanned) return { allowed: true, review: "material ilustrativo aprobado en el storyboard para este tema: no es la evidencia, revisar que no se presente como tal", reason: "ilustrativo planificado" };
      return { allowed: false, reason: "evidencia específica: no se sustituye por recreación ni por material genérico" };
    case "measurable_data":
      if (authentic || graphic) return { allowed: true, reason: authentic ? "evidencia real" : "gráfico/tarjeta determinista" };
      if (illustrativePlanned) return { allowed: true, review: "el dato medible debe verse en un gráfico o tarjeta; esta imagen solo acompaña", reason: "ilustrativo planificado" };
      return { allowed: false, reason: "dato medible: mapa, línea de tiempo, diagrama o tarjeta deterministas" };
    case "hypothesis":
      if (authentic || graphic) return { allowed: true, reason: authentic ? "evidencia real" : "tarjeta/gráfico" };
      if (illustrativePlanned) return hasTextCompanion ? { allowed: true, reason: "ilustrativo planificado con tarjeta de texto en el mismo tramo" }
        : { allowed: true, review: "hipótesis/negación sin tarjeta de texto en el tramo: la imagen no debe confirmar", reason: "ilustrativo planificado" };
      if (t.isNew && t.neutral && hasTextCompanion) return { allowed: true, review: "atmósfera neutral declarada: no representa el hallazgo; el matiz va en la tarjeta/narración", reason: "neutral" };
      return { allowed: false, reason: "hipótesis/negación: no se ilustra con recreación como si fuera confirmación" };
    default:
      return { allowed: true, reason: "atmósfera: sin afirmación factual específica" };
  }
}

/**
 * Factual correspondence (correction 3). A deterministic storyboard asset with specific content (text card,
 * quote, map, timeline, diagram — data_graphic with a planned window) may only illustrate the narration it was
 * planned for: the shot must overlap its planned window, and when both the asset and the unit map to script
 * claims they must be the same claim. A true card next to a different statement would look like its support.
 * The only exception is an explicit continuation (checked by the caller: contiguous, same segment, within the
 * planned duration).
 */
export const MIN_WINDOW_OVERLAP = 0.3;
export function factualCorrespondence(seg: Segment, a: InventoryAsset, start: number, end: number, unit: string, continuation: boolean):
  { applies: boolean; ok: boolean; basis: string[]; reason?: string } {
  const w = a.content?.window;
  if (a.provenance !== "data_graphic" || !w) return { applies: false, ok: true, basis: [] };
  const len = seg.end - seg.start, wFrom = seg.start + w.from * len, wTo = seg.start + w.to * len;
  const overlap = Math.max(0, Math.min(end, wTo) - Math.max(start, wFrom));
  const r = (x: number) => Math.round(x * 10) / 10;
  const basis = [`ventana del storyboard ${r(wFrom)}–${r(wTo)} s; solape ${r(overlap)} s de ${r(end - start)} s`];
  if (w.segmentId !== seg.id) return { applies: true, ok: false, basis, reason: `planificado para ${w.segmentId}, no para ${seg.id}` };
  const assetClaim = claimFor(seg, `${a.content?.visualIntent ?? ""} ${a.content?.description ?? ""}`), unitClaim = claimFor(seg, unit);
  if (assetClaim) basis.push(`afirmación del recurso: ${assetClaim.id}`);
  if (unitClaim) basis.push(`afirmación de la frase: ${unitClaim.id}`);
  if (assetClaim && unitClaim && assetClaim.id !== unitClaim.id)
    return { applies: true, ok: false, basis, reason: `el recurso corresponde a ${assetClaim.id} y la frase a ${unitClaim.id}: una verdad de otra afirmación no la respalda` };
  if (!continuation && overlap < MIN_WINDOW_OVERLAP * (end - start) - 1e-9)
    return { applies: true, ok: false, basis, reason: "fuera de la ventana narrativa del recurso" };
  return { applies: true, ok: true, basis: continuation ? [...basis, "continuación contigua dentro de la duración planificada"] : basis };
}

/** Neutral atmosphere caps (correction 3): a declared pause, never dominant filler. */
export const NEUTRAL_MAX_SHARE = 0.1;
export const NEUTRAL_MAX_PER_SEQUENCE = 1;
