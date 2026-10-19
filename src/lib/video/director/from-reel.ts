/**
 * Adapter: a Reel's storyboard (today the deterministic `simulateStoryboard`, no provider call)
 * -> a Director input (genre "reel", 9:16). Read-only. The inventory is the storyboard's PLANNED material per scene
 * (no bytes, no chosen stock clip yet), so every external asset stays NEEDS_REVIEW: the audit reports it as
 * pending, never as approved. Avatar scenes are passed through as locked segments (never re-planned).
 */
import { directorImageUnitCostUsd } from "@/lib/video/image-pricing";
import type { Storyboard, StoryboardScene } from "@/lib/video/storyboard/types";
import { DIRECTOR_INPUT_VERSION, type DirectorInputRaw, type InventoryAsset } from "./contract";
import { topicsOf } from "./policy";

const PEOPLE = /\b(person|people|man|woman|men|women|creator|face|hands?|kid|child|friends?|someone|user|persona|gente|mujer|hombre|manos?)\b/i;
const TEXT = /\b(text|title|card|typography|texto|titulo|título)\b/i;

function visualTypeOf(scene: StoryboardScene): NonNullable<NonNullable<InventoryAsset["content"]>["visualType"]> {
  const what = `${scene.subject} ${scene.visibleAction}`;
  if (scene.resourceType === "motion_graphic" && TEXT.test(what)) return "text";
  return PEOPLE.test(what) ? "people" : "concept";
}

export type ReelAdapterOptions = {
  /** Scenes covered by an approved avatar take: locked, passed through untouched. */
  avatarScenes?: { sceneId: string; assetId: string }[];
  /** Planning costs used only to estimate what NEW material would cost (no budget is authorised here). */
  unitCostsUsd?: { ai_image: number; ai_video: number };
  /** Shot-length bounds; a shot list passes its own (one planned shot per segment). Default: Reel 1.5–6 s. */
  shotSeconds?: { min: number; max: number };
  /** Declared AI fiction: plan with the fiction recipe set. */
  style?: "fiction";
};

export function inputFromReel(storyboard: Storyboard, opts: ReelAdapterOptions = {}): DirectorInputRaw {
  const avatar = new Map((opts.avatarScenes ?? []).map(a => [a.sceneId, a.assetId]));
  const scenes = [...storyboard.scenes].sort((a, b) => a.order - b.order);
  let cursor = 0;
  const segments = scenes.map(sc => {
    const len = Math.max(0.5, sc.estimatedDurationSeconds);
    const seg = {
      id: sc.id, start: cursor, end: cursor + len, text: sc.narrationText, beat: sc.narrativeGoal,
      ...(avatar.has(sc.id) ? { locked: { reason: "avatar" as const, assetId: avatar.get(sc.id)! } } : {}),
    };
    cursor += len;
    return seg;
  });
  const inventory: InventoryAsset[] = scenes.flatMap(sc => {
    const assets: InventoryAsset[] = [];
    if (avatar.has(sc.id)) {
      assets.push({ id: avatar.get(sc.id)!, kind: "avatar", provenance: "stock_illustrative", motion: "real", license: "CLEARED", tags: [`segment:${sc.id}`, "avatar"],
        content: { visualType: "people", topics: [], visualIntent: "avatar aprobado (bloqueado)" } });
      return assets;
    }
    const video = sc.resourceType === "stock_video" || sc.resourceType === "generated_video";
    const ai = sc.resourceType === "generated_image" || sc.resourceType === "generated_video" || sc.resourceType === "abstract";
    const topics = topicsOf(`${sc.visibleAction} ${sc.stockQueries.join(" ")}`);
    assets.push({
      id: `${sc.id}:planned`,
      kind: sc.resourceType === "motion_graphic" ? "graphic" : video ? "video" : "image",
      provenance: sc.resourceType === "motion_graphic" ? "data_graphic" : ai ? "ai_recreation" : "stock_illustrative",
      motion: video ? "real" : "still",
      // Planned, not chosen: licence unknown until a concrete clip is selected.
      license: sc.resourceType === "motion_graphic" ? "CLEARED" : "NEEDS_REVIEW",
      tags: [`segment:${sc.id}`, ...sc.stockQueries.map(q => q.toLowerCase())],
      content: { visualType: visualTypeOf(sc), topics, visualIntent: sc.visibleAction, description: sc.literalMeaning, window: { segmentId: sc.id, from: 0, to: 1 } },
    });
    return assets;
  });
  return {
    version: DIRECTOR_INPUT_VERSION, genre: "reel", aspect: "9:16", totalSeconds: Math.round(cursor * 1000) / 1000, segments, inventory,
    // Reels are short: 1.5-6 s units read better on a phone than the documentary 3-8 s default.
    constraints: { minShotSeconds: opts.shotSeconds?.min ?? 1.5, maxShotSeconds: opts.shotSeconds?.max ?? 6, maxTitleSeconds: 3, subtitleLines: 2 },
    // Anexo C1 (corrección 2): the image unit cost comes from the image provider's own estimate plus a planning margin
    // (pricing.ts). The previous fixed 0.04 was below OpenAI's 0.05 estimate, so the provider would refuse every fill.
    budget: { remainingUsd: 0, unitCostsUsd: opts.unitCostsUsd ?? { ai_image: directorImageUnitCostUsd(), ai_video: 0.5 } },
    continuity: { wardrobe: storyboard.visualIdentity.wardrobe },
    ...(opts.style ? { style: opts.style } : {}),
  };
}
