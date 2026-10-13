/**
 * Adapter: an existing approved long-form storyboard (content/long-form/<id>/*storyboard*.json, the format
 * storyboard-loader.ts reads) + its script beats -> a DirectorInput, plus baseline metrics of the storyboard as
 * it is. Read-only: it never mutates the source files. The inventory is DERIVED from the storyboard's planned
 * assets (no bytes, no hashes), so duplicate checks there rely on ids/queries only.
 */
import { DIRECTOR_INPUT_VERSION, type DirectorInputRaw, type InventoryAsset } from "./contract";
import { assetVisualType, topicsOf, words } from "./policy";

export type StoryboardShot = {
  beatId: string; shotId: string; durationApprox: number; assetType: string; visualIntent: string;
  queryOrPrompt?: string | null; hybridClassification?: string; licensing?: { status?: string };
  description?: string; productionCategory?: string; factualSensitivity?: string; hybridReason?: string;
};
export type ScriptBeat = { id: string; type?: string; narration: string; claims?: { id: string; text: string; support?: string }[] };

const PROVENANCE: Record<string, InventoryAsset["provenance"]> = {
  AI_RECREATION: "ai_recreation", STOCK_REAL: "stock_illustrative", REAL_DOCUMENTARY: "archival_documentary", DETERMINISTIC: "data_graphic", TEXT: "data_graphic",
};
const BIBLE = new Set(["REAL_DOCUMENTARY", "STOCK_REAL", "DETERMINISTIC", "AI_RECREATION", "TEXT"]);
const SUPPORT = new Set(["sourced", "inference", "unverified"]);

/** Visual type from the storyboard's own asset type/category; topics only refine photographic assets. */
function visualTypeOf(s: StoryboardShot, topics: string[]): NonNullable<NonNullable<InventoryAsset["content"]>["visualType"]> {
  if (s.assetType === "text") return "text";
  if (s.assetType === "map") return "map";
  if (s.assetType === "diagram") return s.productionCategory === "timeline" ? "timeline" : "diagram";
  return assetVisualType({ id: s.shotId, kind: "image", provenance: "stock_illustrative", motion: "still", license: "NEEDS_REVIEW", tags: [], content: { topics } });
}

export function inputFromStoryboard(shots: StoryboardShot[], beats: ScriptBeat[], unitCostsUsd: { ai_image: number; ai_video: number },
  genre: "misterio" | "documental" | "reel" = "documental"): DirectorInputRaw {
  const byBeat = new Map<string, StoryboardShot[]>();
  for (const s of shots) byBeat.set(s.beatId, [...(byBeat.get(s.beatId) ?? []), s]);
  let cursor = 0;
  const segments = beats.filter(b => byBeat.has(b.id)).map(b => {
    const len = byBeat.get(b.id)!.reduce((t, s) => t + s.durationApprox, 0);
    const seg = { id: b.id, start: cursor, end: cursor + len, text: b.narration, beat: b.type,
      // Claims keep their support level so unverified statements are never illustrated as confirmed.
      claims: (b.claims ?? []).filter(c => SUPPORT.has(c.support ?? "")).map(c => ({ id: c.id, text: c.text, support: c.support as "sourced" | "inference" | "unverified" })) };
    cursor += len;
    return seg;
  });
  // Planned window of each storyboard asset inside its beat (fractions of the beat duration, storyboard order).
  const windows = new Map<string, { segmentId: string; from: number; to: number }>();
  for (const [beatId, list] of byBeat) {
    const total = list.reduce((t, s) => t + s.durationApprox, 0) || 1;
    let acc = 0;
    for (const s of list) { windows.set(s.shotId, { segmentId: beatId, from: acc / total, to: (acc + s.durationApprox) / total }); acc += s.durationApprox; }
  }
  const inventory = shots.map(s => {
    // Deterministic diagrams/maps/text cards are drawn in-house from the script (no external file, see the
    // storyboard meta note), so they need no third-party licence. Everything else keeps its recorded status, or
    // NEEDS_REVIEW when none is recorded — the gate then reports it as pending, never as approved.
    const inHouse = s.assetType === "diagram" || s.assetType === "map" || s.assetType === "text";
    const status = inHouse ? "CLEARED" : s.licensing?.status;
    const topics = topicsOf(`${s.visualIntent} ${s.description ?? ""}`);
    const bible = BIBLE.has(s.hybridClassification ?? "") ? s.hybridClassification as NonNullable<NonNullable<InventoryAsset["content"]>["bibleClass"]> : undefined;
    const sensitivity = s.factualSensitivity === "high" || s.factualSensitivity === "medium" || s.factualSensitivity === "low" ? s.factualSensitivity : undefined;
    return {
      id: s.shotId,
      kind: s.assetType === "stock_video" ? "video" : s.assetType === "text" ? "text" : inHouse ? "graphic" : "image",
      provenance: inHouse ? "data_graphic" : PROVENANCE[s.hybridClassification ?? ""] ?? "stock_illustrative",
      motion: s.assetType === "stock_video" ? "real" : "still",
      license: status === "CLEARED" || status === "NOT_CLEARED" ? status : "NEEDS_REVIEW",
      tags: [`segment:${s.beatId}`, ...new Set(words(`${s.visualIntent} ${s.queryOrPrompt ?? ""}`))],
      content: { visualType: visualTypeOf(s, topics), topics, visualIntent: s.visualIntent, description: s.description,
        sensitivity, bibleClass: bible, bibleReason: s.hybridReason, window: windows.get(s.shotId) },
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
