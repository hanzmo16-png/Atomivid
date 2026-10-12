/**
 * Adapter: an existing approved long-form storyboard (content/long-form/<id>/*storyboard*.json, the format
 * storyboard-loader.ts reads) + its script beats -> a DirectorInput, plus baseline metrics of the storyboard as
 * it is. Read-only: it never mutates the source files. The inventory is DERIVED from the storyboard's planned
 * assets (no bytes, no hashes), so duplicate checks there rely on ids/queries only.
 */
import { DIRECTOR_INPUT_VERSION, type DirectorInputRaw, type InventoryAsset } from "./contract";
import { words } from "./propose";

export type StoryboardShot = {
  beatId: string; shotId: string; durationApprox: number; assetType: string; visualIntent: string;
  queryOrPrompt?: string | null; hybridClassification?: string; licensing?: { status?: string };
};
export type ScriptBeat = { id: string; type?: string; narration: string };

const PROVENANCE: Record<string, InventoryAsset["provenance"]> = {
  AI_RECREATION: "ai_recreation", STOCK_REAL: "stock_illustrative", REAL_DOCUMENTARY: "archival_documentary", DETERMINISTIC: "data_graphic",
};

export function inputFromStoryboard(shots: StoryboardShot[], beats: ScriptBeat[], unitCostsUsd: { ai_image: number; ai_video: number },
  genre: "misterio" | "documental" | "reel" = "documental"): DirectorInputRaw {
  const byBeat = new Map<string, StoryboardShot[]>();
  for (const s of shots) byBeat.set(s.beatId, [...(byBeat.get(s.beatId) ?? []), s]);
  let cursor = 0;
  const segments = beats.filter(b => byBeat.has(b.id)).map(b => {
    const len = byBeat.get(b.id)!.reduce((t, s) => t + s.durationApprox, 0);
    const seg = { id: b.id, start: cursor, end: cursor + len, text: b.narration, beat: b.type };
    cursor += len;
    return seg;
  });
  const inventory = shots.filter(s => s.assetType !== "text").map(s => {
    const status = s.licensing?.status;
    return {
      id: s.shotId,
      kind: s.assetType === "stock_video" ? "video" : s.assetType === "diagram" || s.assetType === "map" ? "graphic" : "image",
      provenance: s.assetType === "diagram" || s.assetType === "map" ? "data_graphic" : PROVENANCE[s.hybridClassification ?? ""] ?? "stock_illustrative",
      motion: s.assetType === "stock_video" ? "real" : "still",
      license: status === "CLEARED" || status === "NOT_CLEARED" ? status : "NEEDS_REVIEW",
      tags: [`segment:${s.beatId}`, ...new Set(words(`${s.visualIntent} ${s.queryOrPrompt ?? ""}`))],
    } satisfies InventoryAsset;
  });
  return { version: DIRECTOR_INPUT_VERSION, genre, aspect: "16:9", totalSeconds: cursor, segments, inventory,
    // No budget is authorised for this comparison: any new material shows up as BUDGET_EXCEEDED, never as spend.
    budget: { remainingUsd: 0, unitCostsUsd } };
}

/** Same deterministic indicators on the storyboard as it stands (planning units, not render shots). */
export function storyboardBaseline(shots: StoryboardShot[], minS = 3, maxS = 8, maxTitle = 3) {
  const queries = shots.map(s => (s.queryOrPrompt ?? "").trim().toLowerCase()).filter(Boolean);
  return {
    shots: shots.length,
    longerThanMax: shots.filter(s => s.durationApprox > maxS).length,
    shorterThanMin: shots.filter(s => s.durationApprox < minS).length,
    textCardsOverTitleLimit: shots.filter(s => s.assetType === "text" && s.durationApprox > maxTitle).length,
    repeatedQueries: queries.length - new Set(queries).size,
    aiRecreationShots: shots.filter(s => s.hybridClassification === "AI_RECREATION").length,
    labelsDeclared: "no declarado en el storyboard (el render aplica provenance)",
    note: "los shots del storyboard son unidades de planeación que el pipeline subdivide (shotsForSpan); la comparación no es 1:1",
  };
}
