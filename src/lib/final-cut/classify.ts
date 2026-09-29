/**
 * Repair classification: which intervention level an issue gets. Deterministic table per
 * rule, then confidence and severity gates from the policy. Low confidence always escalates;
 * a rule not in the table escalates (the system never improvises a repair class).
 */
import type { FinalCutPolicy } from "./policy";
import type { Issue, IssueDraft, RepairClass } from "./report";
import { issueId } from "./report";

/** Base class per rule when confidence is high enough. */
const BASE: Record<string, RepairClass> = {
  // AUTO_FIX: deterministic, no paid call.
  V_BLACK_FRAMES: "AUTO_FIX", R_BLACK_MAX: "AUTO_FIX", O_BLACK: "AUTO_FIX", R_DEAD_AIR: "AUTO_FIX", R_TEXT_CARD_MAX: "AUTO_FIX", O_TITLE_CARD: "AUTO_FIX",
  R_TRANSITION_DETERMINISTIC: "AUTO_FIX", R_TRANSITION_DENSITY: "AUTO_FIX", R_CAMERA_MEANINGFUL: "AUTO_FIX",
  A_LOUDNESS: "AUTO_FIX", A_TRUE_PEAK: "AUTO_FIX", A_FADE_IN: "AUTO_FIX", A_FADE_OUT: "AUTO_FIX",
  S_TIMING: "AUTO_FIX", S_TOO_SHORT: "AUTO_FIX", S_TOO_LONG: "AUTO_FIX", S_OVERLAP: "AUTO_FIX", S_OUTSIDE_SPEECH: "AUTO_FIX", S_SAFE_AREA: "AUTO_FIX", S_UNREADABLE: "AUTO_FIX", S_GAP: "AUTO_FIX",
  V_ASSET_REPETITION: "AUTO_FIX", // only when a validated alternate exists; otherwise SMART_REPAIR (see below)
  // SMART_REPAIR: needs another asset, regeneration, animation or a partial re-render.
  R_STATIC_RUN: "SMART_REPAIR", O_STILL_STREAK: "SMART_REPAIR", O_MOVEMENT_DENSITY: "SMART_REPAIR", R_OPENING_MOTION: "SMART_REPAIR", R_HOOK_DENSITY: "SMART_REPAIR", O_SHOT_COUNT: "SMART_REPAIR", O_AVG_SHOT: "SMART_REPAIR",
  V_FREEZE: "SMART_REPAIR", V_SHOT_TOO_LONG: "SMART_REPAIR", R_MIN_VISIBLE: "SMART_REPAIR", R_TOO_FAST_CUTS: "SMART_REPAIR", R_REPETITION: "SMART_REPAIR", O_REPETITION: "SMART_REPAIR",
  V_ANATOMY: "SMART_REPAIR", V_DEFORMED: "SMART_REPAIR", V_MOTION_INCOHERENT: "SMART_REPAIR", A_CLIPPING: "SMART_REPAIR", A_MUSIC_OVER_VOICE: "SMART_REPAIR", A_DISCONTINUITY: "SMART_REPAIR", S_FINAL_TRUNCATED: "SMART_REPAIR", A_WORD_CUT: "SMART_REPAIR",
  // ESCALATE: subjective, high impact or narrative.
  V_IDENTITY: "ESCALATE", V_CONTINUITY: "ESCALATE", R_SPEECH_TIMING: "ESCALATE", R_CONTIGUOUS: "ESCALATE", V_RESOLUTION: "ESCALATE", V_FPS: "ESCALATE",
};

export function classifyIssue(d: IssueDraft, p: FinalCutPolicy, ctx: { hasValidatedAlternate?: boolean; autoFixWithinTolerance?: boolean } = {}): Issue {
  let cls: RepairClass = BASE[d.rule] ?? "ESCALATE";
  if (d.rule === "V_ASSET_REPETITION" && !ctx.hasValidatedAlternate) cls = "SMART_REPAIR";
  if (cls === "AUTO_FIX" && ctx.autoFixWithinTolerance === false) cls = "SMART_REPAIR";
  if (cls === "AUTO_FIX" && d.confidence < p.minConfidenceForAutoFix) cls = d.confidence >= p.minConfidenceForSmartRepair ? "SMART_REPAIR" : "ESCALATE";
  if (cls === "SMART_REPAIR" && d.confidence < p.minConfidenceForSmartRepair) cls = "ESCALATE";
  if (d.severity === "info") cls = "NONE";
  return { ...d, issueId: issueId(d), repairClass: cls };
}
