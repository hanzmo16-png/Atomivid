/**
 * Deterministic "proposal" mode: script segments + inventory + recipes -> a shot plan. No LLM, no network, no
 * media generation, no spend. Same input -> same plan. Generative decisions (framing, prompts) are only
 * DESCRIBED here by the chosen recipe; executing them is left to the existing gated pipeline.
 */
import { hammingHex, PERCEPTUAL_DUPLICATE_MAX_DISTANCE } from "@/lib/video/long-form/asset-identity";
import {
  DIRECTOR_PLAN_VERSION, DirectorInputSchema, DirectorPlanSchema,
  type DirectorInput, type DirectorInputRaw, type DirectorPlan, type InventoryAsset, type PlannedShot, type Recipe, type RecipeCatalog,
} from "./contract";
import { recipesFor } from "./recipes";

const STOP = new Set("a al algo ante con de del el en es esa ese eso esta este la las lo los mas más no o para pero por que qué se sin sobre su sus un una uno y ya the of and to".split(" "));
export const normalize = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
export const words = (t: string) => normalize(t).split(/[^a-z0-9ñ]+/).filter(w => w.length > 2 && !STOP.has(w));

function recipeScore(r: Recipe, text: string): number {
  const bag = new Set(words(text));
  const pos = words([...r.use_when, r.name, r.intent].join(" ")).filter(w => bag.has(w)).length;
  const neg = words(r.avoid_when.join(" ")).filter(w => bag.has(w)).length;
  return pos - neg * 0.5;
}

/** Splits [start,end) into shots of at most maxS (each >= minS when the segment allows it). */
export function splitSpan(start: number, end: number, minS: number, maxS: number): [number, number][] {
  const len = end - start;
  const n = Math.max(1, Math.min(Math.ceil(len / maxS), Math.floor(len / minS) || 1));
  const step = len / n;
  return Array.from({ length: n }, (_, i) => [round(start + i * step), i === n - 1 ? round(end) : round(start + (i + 1) * step)]);
}
const round = (x: number) => Math.round(x * 1000) / 1000;

/** Exact word-range slice of the segment text for shot i of n (always a substring of `text`). */
export function anchorFor(text: string, i: number, n: number): string {
  const tokens = [...text.matchAll(/\S+/g)];
  if (!tokens.length) return "";
  const a = Math.floor((i * tokens.length) / n), b = Math.max(a + 1, Math.floor(((i + 1) * tokens.length) / n));
  const first = tokens[Math.min(a, tokens.length - 1)], last = tokens[Math.min(b, tokens.length) - 1];
  return text.slice(first.index!, last.index! + last[0].length);
}

function isDuplicate(a: InventoryAsset, used: InventoryAsset[]): boolean {
  return used.some(u => u.id === a.id || (a.sha256 && a.sha256 === u.sha256)
    || (a.dhash && u.dhash && hammingHex(a.dhash, u.dhash) <= PERCEPTUAL_DUPLICATE_MAX_DISTANCE));
}

export function proposePlan(raw: DirectorInputRaw, catalog: RecipeCatalog): DirectorPlan {
  const input: DirectorInput = DirectorInputSchema.parse(raw);
  const { minShotSeconds: minS, maxShotSeconds: maxS } = input.constraints;
  const pool = recipesFor(catalog, input.genre);
  const byId = new Map(input.inventory.map(a => [a.id, a]));
  const used: InventoryAsset[] = [];
  const shots: PlannedShot[] = [];
  const recent: string[] = [];
  let estimated = 0;

  for (const seg of input.segments) {
    if (seg.locked) {
      const a = byId.get(seg.locked.assetId);
      shots.push({ id: `${seg.id}-locked`, segmentId: seg.id, start: seg.start, end: seg.end, anchorText: "", recipeId: null, recipeVersion: null,
        intent: `segmento bloqueado (${seg.locked.reason}): se conserva tal cual`, shotType: "bloqueado",
        movement: { kind: "static", realMotion: a?.motion === "real" },
        asset: { status: "locked", assetId: seg.locked.assetId, provenance: a?.provenance, alternatives: [], label: null }, uncertainty: a ? [] : ["el recurso bloqueado no está en el inventario"] });
      if (a) used.push(a);
      continue;
    }
    const evidence = seg.evidenceAssetId ? byId.get(seg.evidenceAssetId) : undefined;
    const spans = splitSpan(seg.start, seg.end, minS, maxS);
    spans.forEach(([start, end], i) => {
      const anchor = anchorFor(seg.text, i, spans.length);
      const useEvidence = i === 0 && evidence && !isDuplicate(evidence, used) ? evidence : undefined;
      // Deterministic graphics (maps, diagrams, timelines) planned for this segment count as verifiable material
      // for authentic-only GRAPHIC recipes (visual bible: geography/chronology are always deterministic).
      const graphic = input.inventory.find(a => a.provenance === "data_graphic" && a.tags.includes(`segment:${seg.id}`) && !isDuplicate(a, used));
      // Authentic-only recipes need authentic evidence; recreation recipes never dress authentic evidence.
      const allowed = pool.filter(r => useEvidence ? r.evidence_policy !== "recreation_ok"
        : r.evidence_policy !== "authentic_only" || (graphic !== undefined && r.shot.type === "gráfico"));
      // Variety: a recipe used in the last shots loses points, so the plan rotates instead of repeating.
      const ranked = allowed.map((r, k) => ({ r, k, s: recipeScore(r, `${seg.text} ${seg.beat ?? ""}`) - recent.filter(id => id === r.id).length * 1.5 }))
        .sort((x, y) => y.s - x.s || x.k - y.k);
      const recipe = (ranked.find(x => x.r.id !== recent[recent.length - 1]) ?? ranked[0])?.r;
      const uncertainty: string[] = [];
      if (!recipe) { uncertainty.push("ninguna receta compatible"); }
      const wantsMotion = recipe?.movement.kind === "real_motion";
      const segWords = new Set(words(seg.text));
      const authenticOnly = recipe?.evidence_policy === "authentic_only";
      const candidates = useEvidence ? [useEvidence] : input.inventory
        .filter(a => a.kind !== "avatar" && a.license !== "NOT_CLEARED" && a.provenance !== "archival_documentary" && !isDuplicate(a, used))
        .filter(a => !authenticOnly || a.provenance === "data_graphic")
        // An asset planned for this segment (tag "segment:<id>") counts most; then word overlap; then real motion if wanted.
        .map(a => ({ a, hit: (a.tags.includes(`segment:${seg.id}`) ? 3 : 0) + a.tags.filter(t => segWords.has(normalize(t))).length + (wantsMotion && a.motion === "real" ? 0.5 : 0) }))
        .filter(x => x.hit >= 1).sort((x, y) => y.hit - x.hit || x.a.id.localeCompare(y.a.id)).map(x => x.a);
      const chosen = candidates[0];
      let movement = recipe?.movement.kind ?? "static";
      let realMotion = movement === "real_motion" && chosen?.motion === "real";
      if (movement === "real_motion" && chosen && chosen.motion !== "real") {
        movement = "push_in_still"; realMotion = false;
        uncertainty.push("movimiento real no disponible: zoom sobre imagen fija (no se presenta como clip en movimiento)");
      }
      let newMaterial: PlannedShot["newMaterial"];
      if (!chosen && recipe) {
        if (recipe.evidence_policy === "authentic_only") uncertainty.push("requiere evidencia auténtica que no está en el inventario; no se genera");
        else {
          const kind = wantsMotion && input.budget.allowAiVideo ? "ai_video" : "ai_image";
          const cost = input.budget.unitCostsUsd[kind];
          newMaterial = { reason: `sin recurso en el inventario para «${anchor.slice(0, 60)}»`, kind, estimatedMaxUsd: cost };
          estimated += cost;
          if (kind === "ai_video") realMotion = true;
          else if (wantsMotion) {
            movement = "push_in_still";
            uncertainty.push("vídeo IA no autorizado: imagen IA con zoom (no se presenta como clip en movimiento)");
          }
        }
      }
      if (chosen) used.push(chosen);
      const provenance = chosen?.provenance ?? (newMaterial ? "ai_recreation" : undefined);
      const label = provenance === "ai_recreation" ? "recreacion_ia" : provenance === "stock_illustrative" ? "ilustrativa" : null;
      shots.push({ id: `${seg.id}-s${i + 1}`, segmentId: seg.id, start, end, anchorText: anchor, recipeId: recipe?.id ?? null, recipeVersion: recipe?.version ?? null,
        intent: recipe?.intent ?? "sin intención asignada", shotType: recipe?.shot.type ?? "sin receta", movement: { kind: movement, realMotion },
        asset: { status: chosen ? "chosen" : newMaterial ? "needs_new" : "none", assetId: chosen?.id, provenance, alternatives: candidates.slice(1, 4).map(a => a.id), label },
        ...(newMaterial ? { newMaterial } : {}), uncertainty });
      if (recipe) { recent.push(recipe.id); if (recent.length > 4) recent.shift(); }
    });
  }
  return DirectorPlanSchema.parse({ version: DIRECTOR_PLAN_VERSION, mode: "proposal", executable: false, paidCalls: 0, genre: input.genre,
    catalogVersion: catalog.version, totalSeconds: input.totalSeconds, shots, estimatedMaxUsd: Math.round(estimated * 100) / 100,
    qualityNote: "semántica y calidad visual: estimado/no validado sin anotación humana" });
}
