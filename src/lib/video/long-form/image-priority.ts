/**
 * Recraft-first image planning (owner decision 2026-10-21). For a plan whose image provider is Recraft, ORIGINAL images
 * are decided from the start instead of following the strategy's fixed shot cycle:
 *
 * - Eligible scenes: ones a recreation/illustration may honestly occupy. Never a scene that requires a real person,
 *   that must prove a fact (authentic evidence), or a physical action of an era without record (schematic) — the same
 *   rule the Cinematic Director applies (generativeVerdict). Text/diagram cards stay as they are.
 * - Priority: the opening first, then the narrative turning points (hook, twist, insight, payoff), then the scenes the
 *   strategy had already marked for illustration, then the rest — earlier scenes first within each tier. Moving
 *   footage is the last candidate (kept when the budget runs out first).
 * - Count: what the APPROVED image budget pays at the chosen provider's price, minus a regeneration reserve for images
 *   that fail the quality check. Every scene not selected stays (or becomes) archive material, which is only used when
 *   pertinent at execution (stock-selection.ts); otherwise the scene becomes a card anchored to its own narration.
 *   Nothing unrelated to the narration ever fills a scene.
 *
 * Pure and deterministic: the plan and the worker run the same function on their shots. It only applies to plans that
 * carry `imagePriority.version === RECRAFT_PRIORITY_VERSION`; confirmed plans without it are never changed.
 */
import type { BeatType, Shot, ShotType } from "./types";
import { generativeVerdict, requiresSchematic } from "./cinematic-director";

export const RECRAFT_PRIORITY_VERSION = "recraft_first_v1" as const;
/** Seconds counted as the opening of a documentary. */
export const OPENING_SEC = 30;
/** Share of the image budget kept for regenerating images that fail the automatic quality check. */
export const REGENERATION_RESERVE_SHARE = 0.1;
const KEY_BEATS: ReadonlySet<BeatType> = new Set(["hook", "twist", "insight", "payoff"]);
const CANDIDATE_TYPES: ReadonlySet<ShotType> = new Set(["generated_placeholder", "ken_burns_image", "stock_image", "stock_video"]);

export type ImagePriorityPlan = {
  version: typeof RECRAFT_PRIORITY_VERSION;
  provider: "recraft";
  /** Original images planned (each one estimated at `perImageUsd`). */
  plannedImages: number;
  /** Extra generations reserved for images that fail the automatic check (never a silent stock substitute). */
  regenerationReserve: number;
  openingImages: number;
  keyMomentImages: number;
  /** Scenes that may not be a recreation (identity / evidence / schematic): archive or card, never AI. */
  protectedScenes: number;
  perImageUsd: number;
  /** Style creation, included in `perImageUsd` (each image is estimated as if it created the style). */
  styleCreationUsd: number;
  /** Ceiling of the image stage: (planned + reserve) × perImageUsd. */
  ceilingUsd: number;
};

/** Images the approved image budget pays, split into planned images and a regeneration reserve. */
export function recraftImageBudget(maxImageUsd: number, perImageUsd: number): { planned: number; reserve: number } {
  if (!(perImageUsd > 0) || !(maxImageUsd > 0)) return { planned: 0, reserve: 0 };
  const total = Math.floor(maxImageUsd / perImageUsd + 1e-9);
  const reserve = total > 1 ? Math.max(1, Math.ceil(total * REGENERATION_RESERVE_SHARE)) : 0;
  return { planned: Math.max(0, total - reserve), reserve };
}

/** Whether a recreation/illustration may occupy this scene. */
export function recreationEligible(shot: Pick<Shot, "type" | "anchoredVisual">): boolean {
  if (!CANDIDATE_TYPES.has(shot.type)) return false;
  if (requiresSchematic(shot.anchoredVisual)) return false;
  return generativeVerdict(shot.anchoredVisual, "image").allowed;
}

function priorityOf(shot: Shot, beatType: BeatType | undefined): number {
  let score = 0;
  if (shot.startSec < OPENING_SEC) score += 1000;
  if (beatType && KEY_BEATS.has(beatType)) score += 100;
  if (shot.type === "generated_placeholder") score += 10;
  if (shot.type === "stock_video") score -= 50;
  return score;
}

/**
 * Re-types the shots: the `maxImages` highest-priority eligible scenes become original images (generated_placeholder);
 * an eligible scene the cycle had marked for an image but that did not fit becomes archive (ken_burns_image), which the
 * executor only fills with pertinent material. Protected scenes are never generated. Order and timing are unchanged.
 */
export function prioritizeOriginalImages<T extends Shot>(shots: T[], beatTypes: ReadonlyMap<string, BeatType>, maxImages: number,
  /** Scenes the allocator already refused to generate (e.g. the Director's HERO reconstruction cap): never re-selected. */
  excluded: ReadonlySet<string> = new Set()):
  { shots: T[]; selected: number; opening: number; keyMoments: number; protectedScenes: number } {
  const ranked = shots
    .map((shot, index) => ({ shot, index, eligible: recreationEligible(shot) && !excluded.has(shot.id), score: priorityOf(shot, beatTypes.get(shot.beatId)) }))
    .filter((c) => c.eligible)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen = new Set(ranked.slice(0, Math.max(0, maxImages)).map((c) => c.index));
  let opening = 0, keyMoments = 0, protectedScenes = 0;
  const out = shots.map((shot, index) => {
    if (CANDIDATE_TYPES.has(shot.type) && !recreationEligible(shot)) protectedScenes += 1;
    if (chosen.has(index)) {
      if (shot.startSec < OPENING_SEC) opening += 1;
      else if (KEY_BEATS.has(beatTypes.get(shot.beatId) as BeatType)) keyMoments += 1;
      return { ...shot, type: "generated_placeholder" as const, source: "generated" as const, motion: "ken_burns" as const };
    }
    if (shot.type === "generated_placeholder") return { ...shot, type: "ken_burns_image" as const, source: "stock" as const, motion: "ken_burns" as const };
    return shot;
  });
  return { shots: out, selected: chosen.size, opening, keyMoments, protectedScenes };
}

/**
 * Prioritizes, lets the real allocator decide (budget caps, Cinematic Director rules such as the HERO reconstruction
 * cap), and re-selects in place of every scene the allocator refused, so the approved budget goes to the next-priority
 * scenes instead of being lost. Bounded and deterministic. Returns the allocator's result and the final counts.
 */
export function allocateWithImagePriority<T extends Shot, A extends { shots: (T & { type: string })[] }>(shots: T[], beatTypes: ReadonlyMap<string, BeatType>,
  maxImages: number, allocate: (shots: T[]) => A): { allocation: A; opening: number; keyMoments: number; protectedScenes: number } {
  const excluded = new Set<string>();
  let result = allocate(prioritizeOriginalImages(shots, beatTypes, maxImages).shots);
  let protectedScenes = prioritizeOriginalImages(shots, beatTypes, maxImages).protectedScenes;
  for (let round = 0; round < 5; round++) {
    const prioritized = prioritizeOriginalImages(shots, beatTypes, maxImages, excluded);
    protectedScenes = prioritized.protectedScenes;
    result = allocate(prioritized.shots);
    const wanted = new Set(prioritized.shots.filter((s) => s.type === "generated_placeholder").map((s) => s.id));
    const refused = result.shots.filter((s) => wanted.has(s.id) && s.type !== "generated_placeholder").map((s) => s.id);
    if (refused.length === 0) break;
    for (const id of refused) excluded.add(id);
  }
  const generated = result.shots.filter((s) => s.type === "generated_placeholder");
  return {
    allocation: result,
    opening: generated.filter((s) => s.startSec < OPENING_SEC).length,
    keyMoments: generated.filter((s) => s.startSec >= OPENING_SEC && KEY_BEATS.has(beatTypes.get(s.beatId) as BeatType)).length,
    protectedScenes,
  };
}
