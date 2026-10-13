/**
 * Deterministic "proposal" mode: script segments + inventory + recipes -> a shot plan. No LLM, no network, no
 * media generation, no spend. Same input -> same plan. Generative decisions are only DESCRIBED here; executing
 * them is left to the existing gated pipeline.
 *
 * Correction 2 (Codex editorial audit): the unit of decision is the anchored narrative unit, not the segment.
 *  1. Anchors follow sentence/clause boundaries (word timestamps when they exist, otherwise estimated time).
 *  2. The documentary policy of the unit (policy.ts) filters what may be shown; evidence is never fabricated.
 *  3. The ASSET is chosen first (topic of the unit, storyboard plan), then a recipe whose operable rule accepts
 *     that asset's visual type. Rotation only breaks ties between compatible recipes.
 *  4. When nothing compatible exists the shot is left honestly PENDING (or, where the policy allows it, a
 *     declared neutral atmosphere) — never a false correspondence.
 * The module records its own reasons (decision, policy, unit, suggestions); nothing is reconstructed afterwards.
 */
import { hammingHex, PERCEPTUAL_DUPLICATE_MAX_DISTANCE } from "@/lib/video/long-form/asset-identity";
import {
  DIRECTOR_PLAN_VERSION, DirectorInputSchema, DirectorPlanSchema,
  type DirectorInput, type DirectorInputRaw, type DirectorPlan, type InventoryAsset, type PlannedShot, type Recipe, type RecipeCatalog,
} from "./contract";
import { recipesFor } from "./recipes";
import {
  assetTopics, assetVisualType, factualCorrespondence, normalize, reelPlannedStockCorresponds, hasTextCompanionFor, NEUTRAL_MAX_PER_SEQUENCE, NEUTRAL_MAX_SHARE, topicsOf, treatmentAllowed, unitPolicy,
  visualFromTopics, words, type UnitPolicy, type VisualType,
} from "./policy";

export { normalize, words };

/** Splits [start,end) into shots of at most maxS (each >= minS when the segment allows it). Kept for callers of V1. */
export function splitSpan(start: number, end: number, minS: number, maxS: number): [number, number][] {
  const len = end - start;
  const n = Math.max(1, Math.min(Math.ceil(len / maxS), Math.floor(len / minS) || 1));
  const step = len / n;
  return Array.from({ length: n }, (_, i) => [round(start + i * step), i === n - 1 ? round(end) : round(start + (i + 1) * step)]);
}
const round = (x: number) => Math.round(x * 1000) / 1000;

/** Exact word-range slice of the segment text for shot i of n (always a substring of `text`). Kept for V1 callers. */
export function anchorFor(text: string, i: number, n: number): string {
  const tokens = [...text.matchAll(/\S+/g)];
  if (!tokens.length) return "";
  const a = Math.floor((i * tokens.length) / n), b = Math.max(a + 1, Math.floor(((i + 1) * tokens.length) / n));
  const first = tokens[Math.min(a, tokens.length - 1)], last = tokens[Math.min(b, tokens.length) - 1];
  return text.slice(first.index!, last.index! + last[0].length);
}

export type Unit = { start: number; end: number; text: string; boundary: "sentence" | "clause" | "word"; timing: "estimated_proportional" | "word_timestamps" };

/**
 * Cuts a segment into anchored units by sense: sentence ends are preferred, then clause boundaries, and only a
 * sentence too long for the maximum shot length is cut between words (and says so). Durations respect the
 * min/max shot length whenever the segment allows it. Deterministic dynamic programme over word boundaries.
 */
export function unitsFor(seg: { start: number; end: number; text: string; wordTimes?: { start: number; end: number }[] }, minS: number, maxS: number): Unit[] {
  const tokens = [...seg.text.matchAll(/\S+/g)];
  const n = tokens.length;
  const len = seg.end - seg.start;
  const timed = !!seg.wordTimes && seg.wordTimes.length === n && n > 0;
  if (n === 0 || len < minS * 2) return [{ start: seg.start, end: seg.end, text: seg.text.trim(), boundary: "sentence", timing: timed ? "word_timestamps" : "estimated_proportional" }];
  // T(k): time at the boundary after k tokens.
  const T = (k: number) => k === 0 ? seg.start : k === n ? seg.end : timed ? Math.min(seg.end, Math.max(seg.start, seg.wordTimes![k - 1].end)) : seg.start + (k / n) * len;
  const kind = (k: number): Unit["boundary"] => {
    if (k === n) return "sentence";
    const w = tokens[k - 1][0];
    if (/[.?!…]["»”)]?$/.test(w)) return "sentence";
    if (/[,;:—–)]["»”]?$/.test(w) || /^[—–(]/.test(tokens[k][0])) return "clause";
    return "word";
  };
  const target = (minS + maxS) / 2;
  const cost = (j: number, k: number) => {
    const d = T(k) - T(j);
    const durPen = d < minS ? 100 + 100 * (minS - d) : d > maxS ? 100 + 100 * (d - maxS) : 0.05 * Math.abs(d - target);
    const b = kind(k);
    return durPen + (b === "sentence" ? 0 : b === "clause" ? 1.5 : 4) + 0.2;
  };
  const best = new Array<number>(n + 1).fill(Infinity), prev = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  for (let k = 1; k <= n; k++) for (let j = 0; j < k; j++) {
    const c = best[j] + cost(j, k);
    if (c < best[k] - 1e-9) { best[k] = c; prev[k] = j; }
  }
  const cuts: number[] = [];
  for (let k = n; k > 0; k = prev[k]) cuts.unshift(k);
  let from = 0;
  return cuts.map(k => {
    const first = tokens[from], last = tokens[k - 1];
    const u: Unit = { start: round(T(from)), end: round(T(k)), text: seg.text.slice(first.index!, last.index! + last[0].length), boundary: kind(k), timing: timed ? "word_timestamps" : "estimated_proportional" };
    from = k;
    return u;
  });
}

function isDuplicate(a: InventoryAsset, used: InventoryAsset[]): boolean {
  return used.some(u => u.id === a.id || (a.sha256 && a.sha256 === u.sha256)
    || (a.dhash && u.dhash && hammingHex(a.dhash, u.dhash) <= PERCEPTUAL_DUPLICATE_MAX_DISTANCE));
}

const labelFor = (p: InventoryAsset["provenance"] | undefined) => p === "ai_recreation" ? "recreacion_ia" as const : p === "stock_illustrative" ? "ilustrativa" as const : null;

type RecipeMatch = { recipe: Recipe; base: number; hits: string[]; generic: boolean };

/** Keyword match on normalised words, tolerant to the simple Spanish plural («resultado» ↔ «resultados», «app» ↔ «apps»). */
export function hasKeyword(unitWords: Set<string>, keyword: string): boolean {
  const k = normalize(keyword);
  return unitWords.has(k) || unitWords.has(`${k}s`) || unitWords.has(`${k}es`) || (k.endsWith("es") && unitWords.has(k.slice(0, -2))) || (k.endsWith("s") && unitWords.has(k.slice(0, -1)));
}

/** Recipes whose operable rule accepts this visual type, provenance and unit. Sorted by rule score only. */
export function compatibleRecipes(pool: Recipe[], visual: VisualType, provenance: InventoryAsset["provenance"], unitText: string, unitTopics: string[],
  position: "first" | "middle" | "last" | "only", neutral: boolean): RecipeMatch[] {
  const kw = new Set(words(unitText));
  const out: RecipeMatch[] = [];
  for (const r of pool) {
    const s = r.select;
    if (!s.visual.includes("*") && !s.visual.includes(visual)) continue;
    if (s.topics_none.some(t => unitTopics.includes(t))) continue;
    if (s.position === "first" && position !== "first" && position !== "only") continue;
    if (s.position === "last" && position !== "last" && position !== "only") continue;
    if (s.neutral !== neutral) continue;
    if (r.evidence_policy === "authentic_only" && provenance !== "archival_documentary" && provenance !== "data_graphic") continue;
    if (r.evidence_policy === "recreation_ok" && provenance === "archival_documentary") continue;
    if (s.provenance.length && !s.provenance.includes(provenance)) continue;
    const hits = [...s.topics_any.filter(t => unitTopics.includes(t)).map(t => `tema:${t}`), ...s.keywords_any.filter(k => hasKeyword(kw, k)).map(k => `palabra:${k}`)];
    // A recipe written for this exact slot (opening hook, closing CTA) is the slot's own rule: it counts as a hit.
    if (s.position !== "any") hits.push(`posición:${s.position}`);
    const constrained = s.topics_any.length + s.keywords_any.length > 0 || s.position !== "any";
    // The slot rule outweighs a single keyword: a recipe written for the opening/closing slot is not displaced there
    // by a generic B-roll recipe that happens to share one word with the sentence.
    out.push({ recipe: r, base: hits.length * 3 + (s.position !== "any" ? 2 : 0) + (s.visual.includes("*") ? 0 : 1), hits, generic: constrained && hits.length === 0 });
  }
  // A recipe whose rule asks for topics/keywords that the unit does not have is only a fallback.
  return out.sort((a, b) => Number(a.generic) - Number(b.generic) || b.base - a.base);
}

export function proposePlan(raw: DirectorInputRaw, catalog: RecipeCatalog): DirectorPlan {
  const input: DirectorInput = DirectorInputSchema.parse(raw);
  const { minShotSeconds: minS, maxShotSeconds: maxS } = input.constraints;
  const pool = recipesFor(catalog, input.genre, input.style);
  const byId = new Map(input.inventory.map(a => [a.id, a]));
  const used: InventoryAsset[] = [];
  const shots: PlannedShot[] = [];
  const recent: string[] = [];
  let estimated = 0;
  // Neutral atmosphere is a declared pause, never dominant filler: at most 10% of the free shots, one per sequence.
  const unitsBySeg = new Map(input.segments.filter(s => !s.locked).map(s => [s.id, unitsFor(s, minS, maxS)]));
  const neutralCap = Math.floor(NEUTRAL_MAX_SHARE * [...unitsBySeg.values()].reduce((n, u) => n + u.length, 0));
  let neutralTotal = 0;

  for (const seg of input.segments) {
    if (seg.locked) {
      const a = byId.get(seg.locked.assetId);
      shots.push({ id: `${seg.id}-locked`, segmentId: seg.id, start: seg.start, end: seg.end, anchorText: "", recipeId: null, recipeVersion: null,
        intent: `segmento bloqueado (${seg.locked.reason}): se conserva tal cual`, shotType: "bloqueado",
        movement: { kind: "static", realMotion: a?.motion === "real" },
        // The locked asset keeps its own provenance and the label that provenance requires (an AI avatar stays labelled).
        asset: { status: "locked", assetId: seg.locked.assetId, provenance: a?.provenance, alternatives: [], label: labelFor(a?.provenance), continuation: false },
        uncertainty: [...(a ? [] : ["el recurso bloqueado no está en el inventario"]), ...(a?.license === "NEEDS_REVIEW" ? ["licencia del recurso bloqueado pendiente de revisión"] : []),
          ...(a?.license === "NOT_CLEARED" ? ["licencia del recurso bloqueado NOT_CLEARED: no se puede aprobar"] : [])],
        unit: { boundary: "sentence", timing: "estimated_proportional", cutReason: "segmento bloqueado: no se corta" },
        policy: { ...unitPolicy(input, seg, seg.text), status: "ok" },
        visualTheme: `segmento bloqueado (${seg.locked.reason})`,
        decision: { status: "proposed", unitTopics: [], assetBasis: ["segmento bloqueado aprobado"], recipeBasis: [], sources: ["storyboard"], neutral: false },
        suggestions: { transitionIn: null, transitionOut: null, composition: null, sound: null, status: "sugerencia_revisable" } });
      if (a) used.push(a);
      continue;
    }
    // Evidence goes through the same licence control as any other asset: NOT_CLEARED is never used.
    const evidenceRaw = seg.evidenceAssetId ? byId.get(seg.evidenceAssetId) : undefined;
    const evidence = evidenceRaw && evidenceRaw.license !== "NOT_CLEARED" ? evidenceRaw : undefined;
    const units = unitsBySeg.get(seg.id)!;
    const hasTextCompanion = hasTextCompanionFor(input, seg.id);
    let prevAsset: InventoryAsset | undefined, prevRecipe: Recipe | undefined, heldSeconds = 0, neutralInSeq = 0;

    units.forEach((u, i) => {
      // Documentary genres place hook/closing recipes per sequence. A Reel is ONE sequence split into scene
      // segments: its hook is the first unit of the video and its call to action the last one.
      const position = input.genre === "reel"
        ? (() => { const segIdx = input.segments.indexOf(seg), first = segIdx === 0 && i === 0, last = segIdx === input.segments.length - 1 && i === units.length - 1;
          return first && last ? "only" : first ? "first" : last ? "last" : "middle"; })()
        : units.length === 1 ? "only" : i === 0 ? "first" : i === units.length - 1 ? "last" : "middle";
      const policy: UnitPolicy = unitPolicy(input, seg, u.text);
      const unitTopics = topicsOf(u.text), unitWords = new Set(words(u.text));
      const mid = ((u.start + u.end) / 2 - seg.start) / (seg.end - seg.start);
      const uncertainty: string[] = [];
      if (u.timing === "estimated_proportional") uncertainty.push("alineación temporal estimada (sin marcas de palabra): no validada contra la locución");
      if (i === 0 && evidenceRaw && !evidence) uncertainty.push(`evidencia ${evidenceRaw.id} NOT_CLEARED: no se usa`);

      // ---- 1. Candidate assets for THIS unit, filtered by the documentary policy.
      type Cand = { a: InventoryAsset; score: number; basis: string[]; topicMatch: boolean; strong: boolean; planned: boolean; continuation: boolean; review?: string };
      const cands: Cand[] = [];
      const useEvidence = i === 0 && evidence && !isDuplicate(evidence, used) ? evidence : undefined;
      for (const a of useEvidence ? [useEvidence] : input.inventory) {
        if (a.kind === "avatar" || a.license === "NOT_CLEARED") continue;
        const planned = a.tags.includes(`segment:${seg.id}`);
        if (a.provenance === "archival_documentary" && !planned && a !== useEvidence) continue;
        // A storyboard graphic/text card says something specific to its own beat: never reused in another one.
        if (a.provenance === "data_graphic" && a.content?.window && a.content.window.segmentId !== seg.id) continue;
        // A deterministic graphic may be held over consecutive shots of the same segment (built up in stages).
        // ...but only for as long as the storyboard planned it (its window), never as filler for the whole beat.
        const plannedSeconds = a.content?.window ? (a.content.window.to - a.content.window.from) * (seg.end - seg.start) : maxS;
        const continuation = !!prevAsset && prevAsset.id === a.id && a.provenance === "data_graphic" && heldSeconds + (u.end - u.start) <= plannedSeconds + 1e-6;
        if (prevAsset?.id === a.id && !continuation) continue;
        if (!continuation && isDuplicate(a, used)) continue;
        const at = assetTopics(a), hitsT = unitTopics.filter(t => at.includes(t));
        const wordHits = a.tags.filter(t => !t.includes(":") && unitWords.has(normalize(t)));
        const inWindow = !!a.content?.window && a.content.window.segmentId === seg.id && mid >= a.content.window.from - 1e-9 && mid <= a.content.window.to + 1e-9;
        // A factual deterministic asset must match this unit's window and claim (correction 3); a true card next to
        // another statement would look like its support. A valid continuation of the same card is the exception.
        const fc = factualCorrespondence(seg, a, u.start, u.end, u.text, continuation);
        if (!fc.ok) continue;
        // Reels: the storyboard derives each planned stock asset from THAT sentence's own visual concepts, so planned
        // illustrative stock corresponds to its sentence by construction (it is drawn with the visible «ilustrativa»
        // label). Documentaries keep the topic-match requirement; AI recreations are never covered by this rule.
        const reelPlannedStock = reelPlannedStockCorresponds(input.genre, a, seg, u.start, u.end);
        const eligible = a === useEvidence || continuation || hitsT.length > 0 || wordHits.length >= 2 || (planned && inWindow && unitTopics.length === 0) || reelPlannedStock;
        if (!eligible) continue;
        const visual = assetVisualType(a);
        const verdict = treatmentAllowed(policy, { provenance: a.provenance, visual, isNew: false, plannedForSegment: planned, topicMatch: hitsT.length > 0 || reelPlannedStock, neutral: false, showsRemains: at.includes("remains") }, hasTextCompanion);
        if (!verdict.allowed) continue;
        const basis = [
          ...(a === useEvidence ? ["evidencia auténtica del segmento"] : []),
          ...(hitsT.length ? [`tema compartido con la frase: ${hitsT.join(", ")}`] : []),
          ...(wordHits.length ? [`palabras compartidas: ${wordHits.slice(0, 4).join(", ")}`] : []),
          ...(planned ? ["planificado en el storyboard para este beat"] : []),
          ...(inWindow ? ["su ventana temporal del storyboard cubre este plano"] : []),
          ...(continuation ? ["continuación del mismo gráfico (se construye por etapas)"] : []),
          ...fc.basis.map(b => `correspondencia factual: ${b}`),
          `política ${policy.class}: ${verdict.reason}`,
        ];
        const score = (a === useEvidence ? 100 : 0) + hitsT.length * 3 + Math.min(wordHits.length, 3) + (planned ? 2 : 0) + (inWindow ? 2 : 0) - (continuation ? 1.5 : 0);
        cands.push({ a, score, basis, topicMatch: hitsT.length > 0, strong: a === useEvidence || hitsT.length > 0 || wordHits.length >= 2, planned, continuation, review: verdict.review });
      }
      cands.sort((x, y) => y.score - x.score || Number(x.continuation) - Number(y.continuation) || x.a.id.localeCompare(y.a.id));

      // ---- 2. Recipe compatible with the chosen asset (rotation only breaks ties among compatible recipes).
      const pickRecipe = (visual: VisualType, provenance: InventoryAsset["provenance"], neutral: boolean) => {
        const m = compatibleRecipes(pool, visual, provenance, u.text, unitTopics, position, neutral);
        if (!m.length) return undefined;
        const top = m.filter(x => x.generic === m[0].generic && x.base === m[0].base);
        const uses = (id: string) => recent.filter(r => r === id).length;
        const chosen = [...top].sort((x, y) => uses(x.recipe.id) - uses(y.recipe.id) || pool.indexOf(x.recipe) - pool.indexOf(y.recipe))[0];
        const tieBreak = top.length < 2 ? null : top.every(t => uses(t.recipe.id) === uses(chosen.recipe.id)) ? "catalog_order" : "rotation";
        return { ...chosen, tieBreak, alternatives: m.filter(x => x !== chosen).slice(0, 3).map(x => x.recipe.id) };
      };

      let chosen: Cand | undefined, match: ReturnType<typeof pickRecipe>;
      for (const c of cands) {
        let m = pickRecipe(assetVisualType(c.a), c.a.provenance, false);
        // A continuation keeps the recipe of the shot it continues when that recipe is still compatible.
        if (m && c.continuation && prevRecipe && m.recipe.id !== prevRecipe.id) {
          const same = compatibleRecipes(pool, assetVisualType(c.a), c.a.provenance, u.text, unitTopics, position, false).find(x => x.recipe.id === prevRecipe!.id);
          if (same) m = { ...same, tieBreak: null, alternatives: m.alternatives };
        }
        if (m) { chosen = c; match = m; break; }
      }
      const recipeless = !chosen ? cands[0] : undefined;

      // ---- 3. No compatible asset: new generic material only where the policy allows it; otherwise pending.
      let newMaterial: PlannedShot["newMaterial"];
      let neutral = false, newVisual: VisualType | null = null, pendingReason: string | undefined, review = chosen?.review;
      if (!chosen && !recipeless) {
        const generic = treatmentAllowed(policy, { provenance: "ai_recreation", visual: visualFromTopics(unitTopics), isNew: true, plannedForSegment: false, topicMatch: false, neutral: false }, hasTextCompanion);
        const asNeutral = treatmentAllowed(policy, { provenance: "ai_recreation", visual: "landscape", isNew: true, plannedForSegment: false, topicMatch: false, neutral: true }, hasTextCompanion);
        if (generic.allowed) { newVisual = visualFromTopics(unitTopics); match = pickRecipe(newVisual, "ai_recreation", false); }
        // One declared neutral shot is a pause; more is filler: beyond the caps the shot stays pending.
        const neutralRoom = neutralInSeq < NEUTRAL_MAX_PER_SEQUENCE && neutralTotal < neutralCap;
        if (!match && asNeutral.allowed && neutralRoom) { neutral = true; newVisual = "landscape"; match = pickRecipe("landscape", "ai_recreation", true); review = asNeutral.review; }
        if (match) {
          const wantsMotion = match.recipe.movement.kind === "real_motion";
          const kind = wantsMotion && input.budget.allowAiVideo ? "ai_video" : "ai_image";
          const cost = input.budget.unitCostsUsd[kind];
          newMaterial = { reason: neutral ? "atmósfera neutral declarada: no hay recurso compatible y la política no permite ilustrar el hallazgo"
            : `sin recurso compatible en el inventario para «${u.text.slice(0, 60)}»`, kind, estimatedMaxUsd: cost };
          estimated += cost;
        } else {
          newVisual = null;
          pendingReason = !generic.allowed && !asNeutral.allowed
            ? `política ${policy.class}: ${generic.reason}; no hay evidencia real ni tarjeta compatible en el inventario → revisión humana (no se genera)`
            : asNeutral.allowed && !neutralRoom ? `tope de atmósfera neutral alcanzado (${NEUTRAL_MAX_PER_SEQUENCE} por secuencia, ${neutralCap} en el plan = ${NEUTRAL_MAX_SHARE * 100} %): no se añade relleno → revisión humana`
            : "ninguna receta del catálogo acepta este tipo de material para esta frase → revisión humana";
        }
      } else if (recipeless) {
        pendingReason = `el recurso ${recipeless.a.id} (${assetVisualType(recipeless.a)}) no tiene receta compatible en el catálogo → revisión humana`;
      }

      const asset = chosen?.a ?? recipeless?.a;
      const recipe = match?.recipe;
      // ---- 4. Movement: real motion only from a real clip (or authorised AI video); a still follows the recipe rule.
      let movement = recipe?.movement.kind ?? "static";
      let realMotion = false;
      if (movement === "real_motion") {
        if (asset?.motion === "real" || newMaterial?.kind === "ai_video") realMotion = true;
        else {
          const still = recipe!.select.still;
          movement = still === "pending" ? "static" : still;
          uncertainty.push(still === "static" ? "la receta pide movimiento real y el recurso es fijo: se propone plano fijo justificado"
            : still === "push_in_still" ? "la receta pide movimiento real y el recurso es fijo: zoom lento declarado (no se presenta como clip)"
            : "movimiento pendiente: no hay clip compatible");
        }
      }
      if (movement === "graphic_animation" && asset?.provenance !== "data_graphic") { movement = "static"; uncertainty.push("animación de gráfico no aplicable a este recurso: plano fijo"); }

      if (asset && !(chosen?.continuation || recipeless?.continuation)) used.push(asset);
      heldSeconds = asset && asset.id === prevAsset?.id ? heldSeconds + (u.end - u.start) : u.end - u.start;
      prevAsset = asset;
      if (neutral) { neutralInSeq++; neutralTotal++; }
      prevRecipe = match?.recipe;
      const provenance = asset?.provenance ?? (newMaterial ? "ai_recreation" : undefined);
      if (asset?.license === "NEEDS_REVIEW") uncertainty.push(`licencia de ${asset.id} pendiente de revisión: no aprobable hasta revisarla`);
      if (review) uncertainty.push(review);
      for (const s of policy.signals) uncertainty.push(s);

      const status: PlannedShot["decision"]["status"] = !recipe || (!asset && !newMaterial) ? "pending"
        : match!.generic || (chosen && !chosen.strong && !chosen.continuation) ? "weak" : "proposed";
      const visualTheme = asset ? (asset.content?.visualIntent ?? `recurso ${asset.id}`)
        : neutral ? "atmósfera neutral (paisaje sin personas ni objetos identificables): no representa el hallazgo"
        : newMaterial ? `recreación genérica (${newVisual}) de: ${unitTopics.join(", ") || "atmósfera"}`
        : "pendiente: evidencia verificada o tarjeta de texto (revisión humana)";
      const sources = new Set<PlannedShot["decision"]["sources"][number]>(["lexicon"]);
      if (chosen?.planned || recipeless?.planned) sources.add("storyboard");
      if (policy.sources.includes("script_claims")) sources.add("script_claims");
      if (recipe) sources.add("catalog_rule");
      if (match?.tieBreak) sources.add(match.tieBreak as "rotation" | "catalog_order");

      shots.push({
        id: `${seg.id}-s${i + 1}`, segmentId: seg.id, start: u.start, end: u.end, anchorText: u.text,
        recipeId: recipe?.id ?? null, recipeVersion: recipe?.version ?? null,
        intent: recipe?.intent ?? "pendiente de dirección humana", shotType: recipe?.shot.type ?? "pendiente",
        movement: { kind: movement, realMotion },
        asset: { status: asset ? "chosen" : newMaterial ? "needs_new" : "none", assetId: asset?.id, provenance,
          alternatives: cands.filter(c => c.a !== asset).slice(0, 3).map(c => c.a.id), label: labelFor(provenance), continuation: !!(chosen?.continuation || recipeless?.continuation) },
        ...(newMaterial ? { newMaterial } : {}),
        uncertainty,
        unit: { boundary: u.boundary, timing: u.timing,
          cutReason: u.boundary === "sentence" ? "fin de oración" : u.boundary === "clause" ? "límite de cláusula: la oración continúa en el plano siguiente"
            : `oración más larga que ${maxS} s: corte entre palabras (revisar)` },
        policy: { ...policy, status: review || policy.status === "review_required" ? "review_required" : "ok" },
        visualTheme,
        decision: { status, unitTopics,
          assetBasis: chosen?.basis ?? recipeless?.basis ?? (newMaterial ? [neutral ? "sin recurso compatible; la política permite solo atmósfera neutral declarada" : "sin recurso compatible en el inventario"] : []),
          recipeBasis: recipe ? [`regla de la receta acepta el tipo visual «${asset ? assetVisualType(asset) : newVisual}»`, ...(match!.hits.length ? [`coincide: ${match!.hits.join(", ")}`] : ["sin tema/palabra de la regla en la frase: receta genérica por tipo visual"]),
            ...(match!.tieBreak ? [`desempate entre recetas compatibles: ${match!.tieBreak === "rotation" ? "rotación" : "orden del catálogo"}`] : []),
            ...(match!.alternatives.length ? [`alternativas compatibles: ${match!.alternatives.join(", ")}`] : [])] : [],
          sources: [...sources], ...(pendingReason ? { pendingReason } : {}), neutral },
        suggestions: { transitionIn: recipe?.transitions.in[0] ?? null, transitionOut: recipe?.transitions.out[0] ?? null, composition: recipe?.composition ?? null,
          sound: recipe?.sfx ? `${recipe.sfx} (sugerencia; no hay asset sonoro)` : null, status: "sugerencia_revisable" },
      });
      if (recipe) { recent.push(recipe.id); if (recent.length > 4) recent.shift(); }
    });
  }
  return DirectorPlanSchema.parse({ version: DIRECTOR_PLAN_VERSION, mode: "proposal", executable: false, paidCalls: 0, genre: input.genre,
    catalogVersion: catalog.version, totalSeconds: input.totalSeconds, shots, estimatedMaxUsd: Math.round(estimated * 100) / 100,
    qualityNote: "semántica y calidad visual: estimado/no validado sin anotación humana" });
}
