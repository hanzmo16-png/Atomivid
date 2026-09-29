/**
 * Edit-timeline adapters: build a MasterEdl from the committed storyboard artifacts of a
 * production. Two generic mappers cover the two storyboard families ATOMIVID has produced
 * (a "motion/assetType" storyboard and a "productionMethod/origin" slot timeline). No
 * project name appears here; the mappers read field families, not titles.
 */
import { EDL_VERSION, emptyMeasured, r2, type EdlSlot, type MasterEdl } from "../edl";
import type { SlotKind, SlotMotion } from "../../production-core/timeline-rules";

/** Family A: shots with durationApprox, assetType, motion ("real-footage", "ai-animation", "still-push…", "map-graphic", "figure-over-motion"). */
export type MotionStoryboard = { meta?: { videoId?: string; cardSecondsMax?: number }; shots: { shotId: string; beatId: string; durationApprox: number; assetType: string; motion: string; reused?: boolean; description?: string }[] };

function motionFamilyKind(assetType: string, motion: string): { kind: SlotKind; motion: SlotMotion } {
  if (motion === "map-graphic") return { kind: "graphic", motion: "static" };
  if (motion === "figure-over-motion") return { kind: "stock_video", motion: "live" };
  if (motion === "real-footage" || assetType === "stock_video") return { kind: "stock_video", motion: "live" };
  if (motion.startsWith("ai-animation")) return { kind: "animated_generated_image", motion: "live" };
  if (motion.startsWith("still-push")) return { kind: assetType === "documentary_image" ? "stock_image" : "generated_image", motion: "camera" };
  if (assetType === "stat_overlay" || assetType === "text") return { kind: "text_card", motion: "static" };
  return { kind: assetType === "generated_image" ? "generated_image" : "stock_image", motion: "static" };
}

export function edlFromMotionStoryboard(sb: MotionStoryboard, ids: { masterId: string; productionId: string; ref: string }, opts: { titleCardSec?: number } = {}): MasterEdl {
  let t = 0;
  const slots: EdlSlot[] = [];
  // The storyboard's own opening title card, when declared, is a real slot on screen.
  if (opts.titleCardSec) { slots.push({ slotId: "title-card", shotId: null, startSec: 0, durationSec: opts.titleCardSec, kind: "text_card", motion: "static", visualKey: "title-card", beatId: sb.shots[0]?.beatId ?? "b0" }); t = opts.titleCardSec; }
  for (const s of sb.shots) {
    const km = motionFamilyKind(s.assetType, s.motion);
    slots.push({ slotId: s.shotId, shotId: s.shotId, startSec: r2(t), durationSec: s.durationApprox, kind: km.kind, motion: km.motion, visualKey: s.reused ? `reused:${s.shotId}` : s.shotId, beatId: s.beatId, sourceProvider: km.kind === "stock_video" ? "pexels" : km.kind === "graphic" || km.kind === "text_card" ? "internal" : km.motion === "live" ? "veo" : "openai" });
    t = r2(t + s.durationApprox);
  }
  return { edlVersion: EDL_VERSION, ...ids, source: { kind: "edit_timeline", ref: ids.ref }, durationSec: r2(t), width: null, height: null, fps: null, slots, speech: [], captions: [], measured: emptyMeasured() };
}

/** Family B: ordered slots with id, src, sec, start, origin (V1/NEW) and productionMethod. */
export type SlotStoryboard = { summary?: { timelineSeconds?: number; estimatedNarrationSeconds?: number }; shots: { id: string; src: string; sec: number; start?: number; beat: string; origin: string; productionMethod: string; visual?: string }[] };

function slotFamilyKind(src: string, method: string): { kind: SlotKind; motion: SlotMotion } {
  if (method === "graphic" || /^G\d/.test(src)) return { kind: "graphic", motion: "static" };
  if (method === "v1_recut") return { kind: "existing_clip", motion: "live" };
  if (method === "i2v_economy" || method === "i2v_hero") return { kind: "animated_generated_image", motion: "live" };
  if (method === "parallax") return { kind: "generated_image", motion: "camera" };
  return { kind: "generated_image", motion: "static" }; // ken_burns: camera on a still = static picture content, PI/Core treat Ken Burns runs as static
}

export function edlFromSlotStoryboard(sb: SlotStoryboard, ids: { masterId: string; productionId: string; ref: string }): MasterEdl {
  let t = 0;
  const slots: EdlSlot[] = sb.shots.map((s) => {
    const km = slotFamilyKind(s.src, s.productionMethod);
    const start = typeof s.start === "number" ? r2(s.start) : r2(t);
    t = r2(start + s.sec);
    return { slotId: s.id, shotId: s.src, startSec: start, durationSec: s.sec, kind: km.kind, motion: km.motion, visualKey: s.src, beatId: s.beat, sourceProvider: km.kind === "existing_clip" ? "existing" : km.kind === "graphic" ? "internal" : km.motion === "live" ? "runway" : "openai" };
  });
  // An ESTIMATED narration length is not speech timing: speech stays empty (reported as not assessable) until measured word timings exist.
  return { edlVersion: EDL_VERSION, ...ids, source: { kind: "edit_timeline", ref: ids.ref }, durationSec: r2(t), width: null, height: null, fps: null, slots, speech: [], captions: [], measured: emptyMeasured() };
}
