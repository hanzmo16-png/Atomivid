/**
 * Deterministic gate for a director plan (the "rules" half of the design). Every check is computable from the
 * plan, the input and the catalog — no model, no media. The gate NEVER trusts what the plan says about itself:
 * provenance, labels, licences and costs are re-derived from the inventory, the input and the catalog, and every
 * reference must resolve. Semantic/visual quality is NOT judged here: the metrics say so ("estimado/no validado").
 */
import { hammingHex, PERCEPTUAL_DUPLICATE_MAX_DISTANCE } from "@/lib/video/long-form/asset-identity";
import { DirectorInputSchema, DirectorPlanSchema, type DirectorInputRaw, type InventoryAsset, type PlannedShot, type RecipeCatalog } from "./contract";
import { assetTopics, assetVisualType, topicsOf, treatmentAllowed, unitPolicy, visualFromTopics } from "./policy";

export type IssueCode =
  | "CONTRACT_INVALID" | "PAID_EXECUTION" | "DURATION_MISMATCH" | "GAP_OR_OVERLAP" | "SEGMENT_NOT_COVERED"
  | "SHOT_TOO_SHORT" | "SHOT_TOO_LONG" | "ANCHOR_NOT_IN_TEXT" | "EMPTY_ANCHOR" | "DUPLICATE_ASSET" | "RECREATION_WITHOUT_LABEL"
  | "AUTHENTIC_WITH_RECREATION_LOOK" | "AUTHENTIC_RECIPE_WITHOUT_EVIDENCE" | "FAKE_MOTION" | "TITLE_TOO_LONG"
  | "LOCKED_SEGMENT_ALTERED" | "CONTINUITY_CONFLICT" | "BUDGET_EXCEEDED" | "UNKNOWN_RECIPE"
  // Correction 1 (Codex audit of PR #105): referential integrity, rights, provenance, recomputed budget, timeline.
  | "DUPLICATE_ID" | "UNKNOWN_SEGMENT" | "UNKNOWN_ASSET" | "INCONSISTENT_ASSET_STATUS" | "NO_MATERIAL"
  | "RECIPE_VERSION_MISMATCH" | "CATALOG_MISMATCH" | "LICENSE_NOT_CLEARED" | "LICENSE_PENDING"
  | "PROVENANCE_MISMATCH" | "LABEL_MISMATCH" | "COST_INCONSISTENT" | "AI_VIDEO_NOT_ALLOWED" | "SHOT_OUTSIDE_SEGMENT"
  // Correction 2 (Codex editorial audit): documentary policy, recipe/asset compatibility, honest pending decisions.
  | "POLICY_MISMATCH" | "POLICY_VIOLATION" | "POLICY_REVIEW" | "DECISION_PENDING" | "RECIPE_INCOMPATIBLE" | "MOVEMENT_INCOMPATIBLE";
export type Issue = { code: IssueCode; shotId?: string; detail: string };

export type AuditMetrics = {
  shots: number; coveragePct: number; durationOk: boolean; duplicates: number; shortShots: number;
  intentVerifiablePct: number; recipeVariety: number; maxSameRecipeRun: number; labelsOk: boolean; needsNew: number;
  licensePending: number; estimatedMaxUsd: number; paidCalls: 0; semanticQuality: "estimado/no validado";
  pendingDecisions: number; policyReview: number; policyViolations: number; realMotionShots: number;
};

const EPS = 0.05;
const TITLE_TYPES = new Set(["rótulo", "rotulo", "title"]);
const round2 = (x: number) => Math.round(x * 100) / 100;
/** The label a shot MUST carry for a given provenance (never taken from the plan). */
export const expectedLabel = (p: InventoryAsset["provenance"] | undefined) =>
  p === "ai_recreation" ? "recreacion_ia" : p === "stock_illustrative" ? "ilustrativa" : null;

function dupIds(ids: string[]): string[] {
  const seen = new Set<string>(), dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

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
  const issues: Issue[] = [];
  const add = (code: IssueCode, detail: string, shotId?: string) => issues.push({ code, detail, ...(shotId ? { shotId } : {}) });

  // ---- Identity: unique ids, catalog version.
  for (const [kind, ids] of [["segment", input.segments.map(s => s.id)], ["shot", plan.shots.map(s => s.id)], ["asset", input.inventory.map(a => a.id)]] as const)
    for (const id of dupIds([...ids])) add("DUPLICATE_ID", `${kind} id «${id}» is not unique`);
  if (plan.catalogVersion !== catalog.version) add("CATALOG_MISMATCH", `plan built with catalog ${plan.catalogVersion}, gate has ${catalog.version}`);

  const recipes = new Map(catalog.recipes.map(r => [r.id, r]));
  const assets = new Map(input.inventory.map(a => [a.id, a]));
  const segs = new Map(input.segments.map(s => [s.id, s]));
  const shots = [...plan.shots].sort((a, b) => a.start - b.start);

  // ---- Licences of the input itself: evidence and locked assets go through the same control as chosen ones.
  const licenseIssue = (a: InventoryAsset, shotId?: string, where = "asset") => {
    if (a.license === "NOT_CLEARED") add("LICENSE_NOT_CLEARED", `${where} ${a.id} is NOT_CLEARED`, shotId);
    else if (a.license === "NEEDS_REVIEW") add("LICENSE_PENDING", `${where} ${a.id} licence NEEDS_REVIEW: pending, never approved`, shotId);
  };

  // ---- Timeline: contiguous, no overlap, sums to the programme.
  let cursor = 0;
  for (const s of shots) {
    if (Math.abs(s.start - cursor) > EPS) add("GAP_OR_OVERLAP", `starts at ${s.start}, expected ${cursor}`, s.id);
    cursor = s.end;
  }
  if (Math.abs(cursor - input.totalSeconds) > EPS) add("DURATION_MISMATCH", `plan ends at ${cursor}s, programme is ${input.totalSeconds}s`);

  // ---- Per segment: every own shot inside the interval, contiguous inside, exact ends; locked = one exact shot.
  const covered = input.segments.filter(seg => {
    const own = shots.filter(s => s.segmentId === seg.id);
    let ok = own.length > 0 && Math.abs(own[0].start - seg.start) <= EPS && Math.abs(own[own.length - 1].end - seg.end) <= EPS;
    for (let i = 1; i < own.length; i++) if (Math.abs(own[i].start - own[i - 1].end) > EPS) ok = false;
    if (!ok) add("SEGMENT_NOT_COVERED", seg.id);
    if (seg.locked) {
      const lockedAsset = assets.get(seg.locked.assetId);
      if (!lockedAsset) add("UNKNOWN_ASSET", `locked segment ${seg.id} references missing asset ${seg.locked.assetId}`);
      else licenseIssue(lockedAsset, undefined, `locked asset of ${seg.id}:`);
      const exact = own.length === 1 && Math.abs(own[0].start - seg.start) <= 1e-6 && Math.abs(own[0].end - seg.end) <= 1e-6;
      if (!exact) add("LOCKED_SEGMENT_ALTERED", `${seg.id} must be exactly one shot ${seg.start}–${seg.end} (has ${own.length})`);
    }
    if (seg.evidenceAssetId) {
      const ev = assets.get(seg.evidenceAssetId);
      if (!ev) add("UNKNOWN_ASSET", `segment ${seg.id} evidence references missing asset ${seg.evidenceAssetId}`);
      else if (own.some(s => s.asset.assetId === ev.id)) licenseIssue(ev, undefined, `evidence of ${seg.id}:`);
    }
    return ok;
  }).length;

  // ---- Budget: recomputed from newMaterial and the INPUT unit costs; the declared total is only cross-checked.
  let recomputed = 0;
  const seen: { id: string; sha?: string; dhash?: string; shot: string }[] = [];
  for (const s of shots) {
    const seg = segs.get(s.segmentId), dur = s.end - s.start;
    if (!seg) add("UNKNOWN_SEGMENT", `shot references unknown segment ${s.segmentId}`, s.id);
    else if (s.start < seg.start - EPS || s.end > seg.end + EPS) add("SHOT_OUTSIDE_SEGMENT", `${s.start}–${s.end} outside ${seg.start}–${seg.end}`, s.id);
    const recipe = s.recipeId ? recipes.get(s.recipeId) : undefined;
    if (s.recipeId && !recipe) add("UNKNOWN_RECIPE", s.recipeId, s.id);
    if (recipe && s.recipeVersion !== recipe.version) add("RECIPE_VERSION_MISMATCH", `${recipe.id} v${s.recipeVersion} vs catalog v${recipe.version}`, s.id);
    if (!seg?.locked && (s.recipeId === null) !== (s.recipeVersion === null)) add("RECIPE_VERSION_MISMATCH", "recipeId and recipeVersion must be set together", s.id);
    const segLen = seg ? seg.end - seg.start : dur;
    if (dur < c.minShotSeconds - EPS && segLen >= c.minShotSeconds) add("SHOT_TOO_SHORT", `${dur.toFixed(2)}s`, s.id);
    if (dur > c.maxShotSeconds + EPS && !seg?.locked) add("SHOT_TOO_LONG", `${dur.toFixed(2)}s`, s.id);
    if (seg && !seg.locked) {
      if (s.anchorText.trim() === "") add("EMPTY_ANCHOR", "a non-locked shot must illustrate a non-empty part of the script", s.id);
      else if (!seg.text.includes(s.anchorText)) add("ANCHOR_NOT_IN_TEXT", s.anchorText.slice(0, 40), s.id);
    }
    if (recipe && TITLE_TYPES.has(recipe.shot.type) && dur > c.maxTitleSeconds + EPS) add("TITLE_TOO_LONG", `title on screen ${dur.toFixed(2)}s > ${c.maxTitleSeconds}s`, s.id);

    // Asset status must be coherent with its references.
    const a = s.asset, asset = a.assetId ? assets.get(a.assetId) : undefined;
    if (a.assetId && !asset) add("UNKNOWN_ASSET", `asset ${a.assetId} is not in the inventory`, s.id);
    if (a.status === "chosen" && !a.assetId) add("INCONSISTENT_ASSET_STATUS", "chosen without assetId", s.id);
    if (a.status === "locked" && (!seg?.locked || a.assetId !== seg.locked.assetId)) add("LOCKED_SEGMENT_ALTERED", seg?.locked ? seg.locked.reason : "locked status on a free segment", s.id);
    if (seg?.locked && a.status !== "locked") add("LOCKED_SEGMENT_ALTERED", `${seg.locked.reason} segment not kept locked`, s.id);
    if (a.status === "needs_new" && (a.assetId || !s.newMaterial)) add("INCONSISTENT_ASSET_STATUS", "needs_new requires newMaterial and no assetId", s.id);
    if (a.status !== "needs_new" && s.newMaterial) add("INCONSISTENT_ASSET_STATUS", `newMaterial on a ${a.status} shot`, s.id);
    if (a.status === "none") add("NO_MATERIAL", "shot has no material; it can never be approved as is", s.id);

    // Provenance and label are derived, never trusted.
    const derived = asset?.provenance ?? (a.status === "needs_new" ? "ai_recreation" : undefined);
    if (a.provenance && derived && a.provenance !== derived) add("PROVENANCE_MISMATCH", `plan says ${a.provenance}, inventory says ${derived}`, s.id);
    if (derived === "ai_recreation" && a.label !== "recreacion_ia") add("RECREATION_WITHOUT_LABEL", "AI recreation must be labelled", s.id);
    else if (derived && a.label !== expectedLabel(derived)) add("LABEL_MISMATCH", `${derived} requires label ${expectedLabel(derived)}, plan has ${a.label}`, s.id);

    if (asset && a.status === "chosen") {
      licenseIssue(asset, s.id);
      // A deterministic graphic may continue over the immediately preceding shot of the same segment; nothing else repeats.
      const prevShot = shots[shots.indexOf(s) - 1];
      const legitContinuation = a.continuation === true && asset.provenance === "data_graphic" && prevShot?.segmentId === s.segmentId && prevShot.asset.assetId === asset.id;
      if (a.continuation && !legitContinuation) add("DUPLICATE_ASSET", `${asset.id}: continuation only for a deterministic graphic right after the same graphic in the same segment`, s.id);
      const dup = legitContinuation ? undefined : seen.find(u => u.id === asset.id || (asset.sha256 && u.sha === asset.sha256) || (asset.dhash && u.dhash && hammingHex(asset.dhash, u.dhash) <= PERCEPTUAL_DUPLICATE_MAX_DISTANCE));
      if (dup) add("DUPLICATE_ASSET", `${asset.id} repeats ${dup.shot}`, s.id);
      seen.push({ id: asset.id, sha: asset.sha256, dhash: asset.dhash, shot: s.id });
      if (s.movement.realMotion && asset.motion !== "real") add("FAKE_MOTION", "a still with a zoom is not a real motion clip", s.id);
      if (asset.provenance === "archival_documentary" && (recipe?.evidence_policy === "recreation_ok" || a.label === "recreacion_ia")) add("AUTHENTIC_WITH_RECREATION_LOOK", asset.id, s.id);
      const era = input.continuity.era, wardrobe = input.continuity.wardrobe;
      for (const t of asset.tags) {
        if (era && t.startsWith("era:") && t.slice(4) !== era) add("CONTINUITY_CONFLICT", `${t} vs era:${era}`, s.id);
        if (wardrobe && t.startsWith("vestuario:") && t.slice(10) !== wardrobe) add("CONTINUITY_CONFLICT", `${t} vs vestuario:${wardrobe}`, s.id);
      }
    }
    if (recipe?.evidence_policy === "authentic_only" && a.status === "chosen" && derived !== "archival_documentary" && derived !== "data_graphic")
      add("AUTHENTIC_RECIPE_WITHOUT_EVIDENCE", `${recipe.id} with ${derived}`, s.id);

    // ---- Correction 2: documentary policy recomputed from the input (never from the plan), compatibility, pending.
    if (seg && !seg.locked) {
      const pol = unitPolicy(input, seg, s.anchorText), unitTopics = topicsOf(s.anchorText);
      if (pol.class !== s.policy.class || pol.unconfirmed !== s.policy.unconfirmed) add("POLICY_MISMATCH", `plan says ${s.policy.class}${s.policy.unconfirmed ? " (no confirmado)" : ""}, recomputed ${pol.class}${pol.unconfirmed ? " (no confirmado)" : ""}`, s.id);
      const hasText = input.inventory.some(x => x.kind === "text" && x.tags.includes(`segment:${seg.id}`) && x.license !== "NOT_CLEARED");
      const neutral = s.decision.neutral === true;
      if (neutral && recipe && !recipe.select.neutral) add("RECIPE_INCOMPATIBLE", `neutral atmosphere declared with non-neutral recipe ${recipe.id}`, s.id);
      if (!neutral && recipe?.select.neutral) add("RECIPE_INCOMPATIBLE", `${recipe.id} is only for a declared neutral atmosphere`, s.id);
      let visual: ReturnType<typeof assetVisualType> | undefined, verdict: ReturnType<typeof treatmentAllowed> | undefined;
      if (asset && a.status === "chosen") {
        visual = assetVisualType(asset);
        const at = assetTopics(asset);
        verdict = treatmentAllowed(pol, { provenance: asset.provenance, visual, isNew: false, plannedForSegment: asset.tags.includes(`segment:${seg.id}`),
          topicMatch: unitTopics.some(t => at.includes(t)), neutral: false, showsRemains: at.includes("remains") }, hasText);
      } else if (a.status === "needs_new") {
        visual = neutral ? "landscape" : visualFromTopics(unitTopics);
        verdict = treatmentAllowed(pol, { provenance: "ai_recreation", visual, isNew: true, plannedForSegment: false, topicMatch: false, neutral }, hasText);
      }
      if (verdict && !verdict.allowed) add("POLICY_VIOLATION", `${pol.class}: ${verdict.reason}`, s.id);
      else if (verdict?.review || pol.status === "review_required") add("POLICY_REVIEW", verdict?.review ?? pol.signals.join("; "), s.id);
      if (recipe && visual) {
        if (!recipe.select.visual.includes("*") && !recipe.select.visual.includes(visual)) add("RECIPE_INCOMPATIBLE", `${recipe.id} does not accept visual type ${visual}`, s.id);
        if (recipe.select.provenance.length && derived && !recipe.select.provenance.includes(derived)) add("RECIPE_INCOMPATIBLE", `${recipe.id} cannot dress ${derived}`, s.id);
        if (recipe.select.topics_none.some(t => unitTopics.includes(t))) add("RECIPE_INCOMPATIBLE", `${recipe.id} excludes topic ${recipe.select.topics_none.filter(t => unitTopics.includes(t)).join(", ")}`, s.id);
      }
      if (!s.recipeId || a.status === "none" || s.decision.status === "pending") add("DECISION_PENDING", s.decision.pendingReason ?? "no recipe or no material: human direction required", s.id);
      if (s.movement.kind === "graphic_animation" && derived !== "data_graphic") add("MOVEMENT_INCOMPATIBLE", "graphic animation on a non-graphic asset", s.id);
      if (s.movement.realMotion && a.status === "needs_new" && s.newMaterial?.kind !== "ai_video") add("FAKE_MOTION", "an AI still is not a motion clip", s.id);
    }

    if (s.newMaterial) {
      const unit = input.budget.unitCostsUsd[s.newMaterial.kind];
      if (Math.abs(s.newMaterial.estimatedMaxUsd - unit) > 1e-9) add("COST_INCONSISTENT", `${s.newMaterial.kind} declared ${s.newMaterial.estimatedMaxUsd}, unit cost is ${unit}`, s.id);
      if (s.newMaterial.kind === "ai_video" && !input.budget.allowAiVideo) add("AI_VIDEO_NOT_ALLOWED", "allowAiVideo=false", s.id);
      if (recipe?.evidence_policy === "authentic_only") add("AUTHENTIC_RECIPE_WITHOUT_EVIDENCE", `${recipe.id} cannot be generated`, s.id);
      recomputed += unit;
    }
  }
  recomputed = round2(recomputed);
  if (Math.abs(plan.estimatedMaxUsd - recomputed) > 0.005) add("COST_INCONSISTENT", `declared total ${plan.estimatedMaxUsd}, recomputed ${recomputed}`);
  const budgetBasis = Math.max(plan.estimatedMaxUsd, recomputed);
  if (budgetBasis > input.budget.remainingUsd + 1e-9) add("BUDGET_EXCEEDED", `${budgetBasis} > ${input.budget.remainingUsd} (estimates, never an authorisation)`);

  const unlocked = shots.filter((s: PlannedShot) => s.asset.status !== "locked");
  const metrics: AuditMetrics = {
    shots: shots.length,
    coveragePct: Math.round((covered / input.segments.length) * 1000) / 10,
    durationOk: !issues.some(i => i.code === "DURATION_MISMATCH" || i.code === "GAP_OR_OVERLAP"),
    duplicates: issues.filter(i => i.code === "DUPLICATE_ASSET").length,
    shortShots: issues.filter(i => i.code === "SHOT_TOO_SHORT").length,
    intentVerifiablePct: unlocked.length ? Math.round((unlocked.filter(s => s.recipeId && s.anchorText.trim()).length / unlocked.length) * 1000) / 10 : 100,
    // Distinct recipes used / recipes that could have been used (genre pool, capped by the number of shots).
    recipeVariety: unlocked.length ? Math.round((new Set(unlocked.map(s => s.recipeId)).size / Math.min(unlocked.length, catalog.recipes.filter(r => r.genre === plan.genre).length)) * 100) / 100 : 0,
    maxSameRecipeRun: unlocked.reduce((acc, s, i) => { const run = i && unlocked[i - 1].recipeId === s.recipeId ? acc.run + 1 : 1; return { run, max: Math.max(acc.max, run) }; }, { run: 0, max: 0 }).max,
    labelsOk: !issues.some(i => ["RECREATION_WITHOUT_LABEL", "AUTHENTIC_WITH_RECREATION_LOOK", "LABEL_MISMATCH", "PROVENANCE_MISMATCH"].includes(i.code)),
    needsNew: shots.filter(s => s.asset.status === "needs_new").length,
    licensePending: issues.filter(i => i.code === "LICENSE_PENDING").length,
    estimatedMaxUsd: recomputed, paidCalls: 0, semanticQuality: "estimado/no validado",
    pendingDecisions: issues.filter(i => i.code === "DECISION_PENDING").length,
    policyReview: issues.filter(i => i.code === "POLICY_REVIEW").length,
    policyViolations: issues.filter(i => i.code === "POLICY_VIOLATION").length,
    realMotionShots: shots.filter(s => s.movement.realMotion).length,
  };
  return { ok: issues.length === 0, issues, metrics };
}
