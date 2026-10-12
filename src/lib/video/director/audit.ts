/**
 * Deterministic gate for a director plan (the "rules" half of the design). Every check is computable from the
 * plan, the input and the catalog — no model, no media. Semantic/visual quality is NOT judged here: the metrics
 * say so explicitly ("estimado/no validado").
 */
import { hammingHex, PERCEPTUAL_DUPLICATE_MAX_DISTANCE } from "@/lib/video/long-form/asset-identity";
import { DirectorInputSchema, DirectorPlanSchema, type DirectorInputRaw, type RecipeCatalog } from "./contract";

export type IssueCode =
  | "CONTRACT_INVALID" | "PAID_EXECUTION" | "DURATION_MISMATCH" | "GAP_OR_OVERLAP" | "SEGMENT_NOT_COVERED"
  | "SHOT_TOO_SHORT" | "SHOT_TOO_LONG" | "ANCHOR_NOT_IN_TEXT" | "DUPLICATE_ASSET" | "RECREATION_WITHOUT_LABEL"
  | "AUTHENTIC_WITH_RECREATION_LOOK" | "AUTHENTIC_RECIPE_WITHOUT_EVIDENCE" | "FAKE_MOTION" | "TITLE_TOO_LONG"
  | "LOCKED_SEGMENT_ALTERED" | "CONTINUITY_CONFLICT" | "BUDGET_EXCEEDED" | "UNKNOWN_RECIPE";
export type Issue = { code: IssueCode; shotId?: string; detail: string };

export type AuditMetrics = {
  shots: number; coveragePct: number; durationOk: boolean; duplicates: number; shortShots: number;
  intentVerifiablePct: number; recipeVariety: number; maxSameRecipeRun: number; labelsOk: boolean; needsNew: number;
  estimatedMaxUsd: number; paidCalls: 0; semanticQuality: "estimado/no validado";
};

const EPS = 0.05;
const TITLE_TYPES = new Set(["rótulo", "rotulo", "title"]);

export function auditPlan(planRaw: unknown, inputRaw: DirectorInputRaw, catalog: RecipeCatalog): { ok: boolean; issues: Issue[]; metrics: AuditMetrics | null } {
  const parsedPlan = DirectorPlanSchema.safeParse(planRaw), parsedInput = DirectorInputSchema.safeParse(inputRaw);
  if (!parsedPlan.success || !parsedInput.success) {
    const paid = typeof planRaw === "object" && planRaw !== null && ((planRaw as { executable?: unknown }).executable !== false || (planRaw as { paidCalls?: unknown }).paidCalls !== 0);
    return { ok: false, metrics: null, issues: [
      ...(paid ? [{ code: "PAID_EXECUTION" as const, detail: "a plan must never be executable nor carry paid calls" }] : []),
      { code: "CONTRACT_INVALID", detail: (parsedPlan.success ? parsedInput.error : parsedPlan.error)!.issues.slice(0, 3).map(i => `${i.path.join(".")}: ${i.message}`).join("; ") },
    ] };
  }
  const plan = parsedPlan.data, input = parsedInput.data, { constraints: c } = input;
  const recipes = new Map(catalog.recipes.map(r => [r.id, r]));
  const assets = new Map(input.inventory.map(a => [a.id, a]));
  const segs = new Map(input.segments.map(s => [s.id, s]));
  const issues: Issue[] = [];
  const shots = [...plan.shots].sort((a, b) => a.start - b.start);

  // Timeline: contiguous, no overlap, sums to the programme.
  let cursor = 0;
  for (const s of shots) {
    if (Math.abs(s.start - cursor) > EPS) issues.push({ code: "GAP_OR_OVERLAP", shotId: s.id, detail: `starts at ${s.start}, expected ${cursor}` });
    cursor = s.end;
  }
  if (Math.abs(cursor - input.totalSeconds) > EPS) issues.push({ code: "DURATION_MISMATCH", detail: `plan ends at ${cursor}s, programme is ${input.totalSeconds}s` });
  const covered = input.segments.filter(seg => {
    const own = shots.filter(s => s.segmentId === seg.id);
    const ok = own.length > 0 && Math.abs(own[0].start - seg.start) <= EPS && Math.abs(own[own.length - 1].end - seg.end) <= EPS;
    if (!ok) issues.push({ code: "SEGMENT_NOT_COVERED", detail: seg.id });
    return ok;
  }).length;

  const seen: { id: string; sha?: string; dhash?: string; shot: string }[] = [];
  for (const s of shots) {
    const seg = segs.get(s.segmentId), dur = s.end - s.start, recipe = s.recipeId ? recipes.get(s.recipeId) : undefined;
    const segLen = seg ? seg.end - seg.start : dur;
    if (s.recipeId && !recipe) issues.push({ code: "UNKNOWN_RECIPE", shotId: s.id, detail: s.recipeId });
    if (dur < c.minShotSeconds - EPS && segLen >= c.minShotSeconds) issues.push({ code: "SHOT_TOO_SHORT", shotId: s.id, detail: `${dur.toFixed(2)}s` });
    if (dur > c.maxShotSeconds + EPS && !seg?.locked) issues.push({ code: "SHOT_TOO_LONG", shotId: s.id, detail: `${dur.toFixed(2)}s` });
    if (seg && !seg.locked && !seg.text.includes(s.anchorText)) issues.push({ code: "ANCHOR_NOT_IN_TEXT", shotId: s.id, detail: s.anchorText.slice(0, 40) });
    if (recipe && TITLE_TYPES.has(recipe.shot.type) && dur > c.maxTitleSeconds + EPS) issues.push({ code: "TITLE_TOO_LONG", shotId: s.id, detail: `title on screen ${dur.toFixed(2)}s > ${c.maxTitleSeconds}s` });
    if (seg?.locked && (s.asset.status !== "locked" || s.asset.assetId !== seg.locked.assetId)) issues.push({ code: "LOCKED_SEGMENT_ALTERED", shotId: s.id, detail: seg.locked.reason });
    const asset = s.asset.assetId ? assets.get(s.asset.assetId) : undefined;
    if (asset && s.asset.status !== "locked") {
      const dup = seen.find(u => u.id === asset.id || (asset.sha256 && u.sha === asset.sha256) || (asset.dhash && u.dhash && hammingHex(asset.dhash, u.dhash) <= PERCEPTUAL_DUPLICATE_MAX_DISTANCE));
      if (dup) issues.push({ code: "DUPLICATE_ASSET", shotId: s.id, detail: `${asset.id} repeats ${dup.shot}` });
      seen.push({ id: asset.id, sha: asset.sha256, dhash: asset.dhash, shot: s.id });
      if (s.movement.realMotion && asset.motion !== "real") issues.push({ code: "FAKE_MOTION", shotId: s.id, detail: "a still with a zoom is not a real motion clip" });
      if (asset.provenance === "archival_documentary" && (recipe?.evidence_policy === "recreation_ok" || s.asset.label === "recreacion_ia"))
        issues.push({ code: "AUTHENTIC_WITH_RECREATION_LOOK", shotId: s.id, detail: asset.id });
      const era = input.continuity.era, wardrobe = input.continuity.wardrobe;
      for (const t of asset.tags) {
        if (era && t.startsWith("era:") && t.slice(4) !== era) issues.push({ code: "CONTINUITY_CONFLICT", shotId: s.id, detail: `${t} vs era:${era}` });
        if (wardrobe && t.startsWith("vestuario:") && t.slice(10) !== wardrobe) issues.push({ code: "CONTINUITY_CONFLICT", shotId: s.id, detail: `${t} vs vestuario:${wardrobe}` });
      }
    }
    const provenance = s.asset.provenance ?? asset?.provenance;
    if (provenance === "ai_recreation" && s.asset.label !== "recreacion_ia") issues.push({ code: "RECREATION_WITHOUT_LABEL", shotId: s.id, detail: "AI recreation must be labelled" });
    if (recipe?.evidence_policy === "authentic_only" && s.asset.status === "chosen" && provenance !== "archival_documentary" && provenance !== "data_graphic")
      issues.push({ code: "AUTHENTIC_RECIPE_WITHOUT_EVIDENCE", shotId: s.id, detail: `${recipe.id} with ${provenance}` });
  }
  if (plan.estimatedMaxUsd > input.budget.remainingUsd + 1e-9) issues.push({ code: "BUDGET_EXCEEDED", detail: `${plan.estimatedMaxUsd} > ${input.budget.remainingUsd}` });

  const unlocked = shots.filter(s => s.asset.status !== "locked");
  const metrics: AuditMetrics = {
    shots: shots.length,
    coveragePct: Math.round((covered / input.segments.length) * 1000) / 10,
    durationOk: !issues.some(i => i.code === "DURATION_MISMATCH" || i.code === "GAP_OR_OVERLAP"),
    duplicates: issues.filter(i => i.code === "DUPLICATE_ASSET").length,
    shortShots: issues.filter(i => i.code === "SHOT_TOO_SHORT").length,
    intentVerifiablePct: unlocked.length ? Math.round((unlocked.filter(s => s.recipeId && s.anchorText).length / unlocked.length) * 1000) / 10 : 100,
    // Distinct recipes used / recipes that could have been used (genre pool, capped by the number of shots).
    recipeVariety: unlocked.length ? Math.round((new Set(unlocked.map(s => s.recipeId)).size / Math.min(unlocked.length, catalog.recipes.filter(r => r.genre === plan.genre).length)) * 100) / 100 : 0,
    maxSameRecipeRun: unlocked.reduce((acc, s, i) => { const run = i && unlocked[i - 1].recipeId === s.recipeId ? acc.run + 1 : 1; return { run, max: Math.max(acc.max, run) }; }, { run: 0, max: 0 }).max,
    labelsOk: !issues.some(i => i.code === "RECREATION_WITHOUT_LABEL" || i.code === "AUTHENTIC_WITH_RECREATION_LOOK"),
    needsNew: shots.filter(s => s.asset.status === "needs_new").length,
    estimatedMaxUsd: plan.estimatedMaxUsd, paidCalls: 0, semanticQuality: "estimado/no validado",
  };
  return { ok: issues.length === 0, issues, metrics };
}
