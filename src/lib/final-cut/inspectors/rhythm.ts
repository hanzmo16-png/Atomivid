/**
 * Editorial rhythm: reuses the Production Core timeline evaluator (same thresholds) and adds
 * the cut-speed checks. Every finding maps to a rhythm rule id and a time range.
 */
import { evaluateTimeline, type TimelineSlot } from "../../production-core/timeline-rules";
import { slotEnd, slotsSorted, r2, type MasterEdl } from "../edl";
import type { FinalCutPolicy } from "../policy";
import type { IssueDraft } from "../report";

const SEV: Record<string, IssueDraft["severity"]> = { R_STATIC_RUN: "major", R_OPENING_MOTION: "major", R_HOOK_DENSITY: "major", R_MIN_VISIBLE: "minor", R_TEXT_CARD_MAX: "major", R_BLACK_MAX: "major", R_SPEECH_TIMING: "blocking", R_REPETITION: "minor", R_CAMERA_MEANINGFUL: "minor", R_TRANSITION_DENSITY: "minor", R_TRANSITION_DETERMINISTIC: "minor", R_CONTIGUOUS: "blocking" };
const ACTION: Record<string, string> = { R_STATIC_RUN: "add camera motion or a moving cutaway inside the run", R_OPENING_MOTION: "open on a moving slot", R_HOOK_DENSITY: "add cuts inside the hook window", R_MIN_VISIBLE: "extend or merge the slot", R_TEXT_CARD_MAX: "shorten the text card", R_BLACK_MAX: "shorten the black", R_SPEECH_TIMING: "re-conform picture to narration", R_REPETITION: "substitute the repeated asset", R_CAMERA_MEANINGFUL: "remove camera motion from the card", R_TRANSITION_DENSITY: "replace dissolves with cuts", R_TRANSITION_DETERMINISTIC: "apply the transition policy", R_CONTIGUOUS: "close the gap / overlap" };

export function inspectRhythm(e: MasterEdl, p: FinalCutPolicy, openingMotionRequested = true): { issues: IssueDraft[]; stats: ReturnType<typeof evaluateTimeline>["stats"] } {
  const slots = slotsSorted(e);
  const tl: TimelineSlot[] = slots.map((s) => ({ slotId: s.slotId, startSec: s.startSec, durationSec: s.durationSec, kind: s.kind, motion: s.motion, visualKey: s.visualKey, beatId: s.beatId }));
  const r = evaluateTimeline(tl, p.rhythm, { speech: e.speech, openingMotionRequested });
  const byId = new Map(slots.map((s) => [s.slotId, s]));
  const issues: IssueDraft[] = r.findings.map((f) => {
    const first = f.slotIds.length ? byId.get(f.slotIds[0]) : undefined, last = f.slotIds.length ? byId.get(f.slotIds[f.slotIds.length - 1]) : undefined;
    return { category: "rhythm", rule: f.rule, severity: SEV[f.rule] ?? (f.severity === "error" ? "major" : "minor"), confidence: e.source.kind === "media" ? 0.7 : 0.95, startTime: first ? first.startSec : null, endTime: last ? slotEnd(last) : null, shotId: f.slotIds.length === 1 ? first?.shotId ?? null : null, description: f.message, evidence: { slotIds: f.slotIds }, recommendedAction: ACTION[f.rule] ?? "editorial review" };
  });
  // Too-fast cutting: a run of consecutive very short slots.
  let run: typeof slots = [];
  const flush = () => { if (run.length >= p.visual.tooFastRunMin) issues.push({ category: "rhythm", rule: "R_TOO_FAST_CUTS", severity: "minor", confidence: 0.9, startTime: run[0].startSec, endTime: slotEnd(run[run.length - 1]), shotId: null, description: `${run.length} consecutive cuts shorter than ${p.visual.tooFastCutSec} s`, evidence: { slotIds: run.map((s) => s.slotId), totalSec: r2(run.reduce((t, s) => t + s.durationSec, 0)) }, recommendedAction: "merge slots to restore breathing room" }); run = []; };
  for (const s of slots) { if (s.durationSec < p.visual.tooFastCutSec) run.push(s); else flush(); }
  flush();
  // Unnecessary silence inside the picture (measured) that no speech pause explains.
  if (e.measured.silenceIntervals) for (const si of e.measured.silenceIntervals) {
    const dur = r2(si.endSec - si.startSec);
    if (dur <= p.audio.maxSilenceSec) continue;
    issues.push({ category: "rhythm", rule: "R_DEAD_AIR", severity: "major", confidence: 0.9, startTime: si.startSec, endTime: si.endSec, shotId: null, description: `${dur} s of silence in the mix`, evidence: { durationSec: dur }, recommendedAction: dur - p.audio.maxSilenceSec <= p.autoFix.maxSilenceTrimSec ? "trim the silence" : "re-conform the timeline" });
  }
  return { issues, stats: r.stats };
}
