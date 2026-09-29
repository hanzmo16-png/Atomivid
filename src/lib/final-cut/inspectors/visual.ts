/**
 * Visual inspection. Measured signals (black, freeze, resolution) carry high confidence.
 * Semantic defects (deformed AI images, face/character changes, anomalous hands) are NOT
 * detected from pixels here: they are reported only from production QA evidence attached
 * to a slot, with the confidence that evidence deserves; otherwise the report says so.
 */
import { slotAt, slotEnd, slotsSorted, r2, type MasterEdl } from "../edl";
import type { FinalCutPolicy } from "../policy";
import type { IssueDraft } from "../report";

export function inspectVisual(e: MasterEdl, p: FinalCutPolicy): { issues: IssueDraft[]; notAssessable: string[] } {
  const out: IssueDraft[] = [];
  const na: string[] = [];
  const slots = slotsSorted(e);
  // Technical format.
  if (e.width !== null && e.height !== null && (e.width !== p.visual.expectedWidth || e.height !== p.visual.expectedHeight)) out.push({ category: "technical", rule: "V_RESOLUTION", severity: "blocking", confidence: 1, startTime: null, endTime: null, shotId: null, description: `master is ${e.width}x${e.height}, expected ${p.visual.expectedWidth}x${p.visual.expectedHeight}`, evidence: { width: e.width, height: e.height }, recommendedAction: "re-render at the profile resolution" });
  if (e.fps !== null && Math.abs(e.fps - p.visual.expectedFps) > 0.5) out.push({ category: "technical", rule: "V_FPS", severity: "major", confidence: 1, startTime: null, endTime: null, shotId: null, description: `frame rate ${e.fps} vs expected ${p.visual.expectedFps}`, evidence: { fps: e.fps }, recommendedAction: "re-render at the profile frame rate" });
  if (e.width === null) na.push("resolution/aspect (no media probe)");
  // Unexpected black: measured intervals not covered by an intentional black slot.
  if (e.measured.blackIntervals === null) na.push("black frames (no media measurement)");
  else for (const b of e.measured.blackIntervals) {
    const dur = r2(b.endSec - b.startSec);
    const intentional = slots.some((s) => s.kind === "black" && b.startSec >= s.startSec - 0.05 && b.endSec <= slotEnd(s) + 0.05);
    if (intentional || dur <= p.visual.maxUnexpectedBlackSec) continue;
    const atEdge = b.startSec < 0.05 || b.endSec > e.durationSec - 0.05;
    out.push({ category: "visual", rule: "V_BLACK_FRAMES", severity: dur > 2 ? "major" : "minor", confidence: 0.97, startTime: b.startSec, endTime: b.endSec, shotId: slotAt(e, b.startSec)?.shotId ?? null, description: `${dur} s of unexpected black${atEdge ? " at the edge" : ""}`, evidence: { durationSec: dur, atEdge }, recommendedAction: atEdge ? "trim the black frames" : "re-cut the slot boundary" });
  }
  // Freeze frames: measured stillness inside a slot that is supposed to move.
  if (e.measured.freezeIntervals === null) na.push("freeze frames (no media measurement)");
  else for (const f of e.measured.freezeIntervals) {
    const dur = r2(f.endSec - f.startSec);
    if (dur < p.visual.freezeSec) continue;
    const s = slotAt(e, f.startSec);
    if (s && s.motion === "static") continue; // an intentional still is not a freeze
    out.push({ category: "visual", rule: "V_FREEZE", severity: "major", confidence: 0.85, startTime: f.startSec, endTime: f.endSec, shotId: s?.shotId ?? null, description: `${dur} s frozen picture inside a ${s?.motion ?? "unknown"} slot`, evidence: { durationSec: dur, slotMotion: s?.motion ?? null }, recommendedAction: "replace the clip or add camera motion" });
  }
  // Duplicates / repetition: same visualKey twice within the rhythm window (visible reuse).
  const lastSeen = new Map<string, (typeof slots)[number]>();
  for (const s of slots) {
    const prev = lastSeen.get(s.visualKey);
    if (prev) {
      const gap = r2(s.startSec - slotEnd(prev));
      if (gap >= 0 && gap < p.rhythm.repetitionWindowSec) out.push({ category: "visual", rule: "V_ASSET_REPETITION", severity: gap < 5 ? "major" : "minor", confidence: 0.95, startTime: s.startSec, endTime: slotEnd(s), shotId: s.shotId, description: `asset ${s.visualKey} reappears ${gap} s after its previous use`, evidence: { previousSlot: prev.slotId, gapSec: gap }, recommendedAction: s.validatedAlternates?.length ? "substitute an already-validated alternate" : "substitute or re-cut" });
    }
    lastSeen.set(s.visualKey, s);
  }
  // Static too long (single slot) is a rhythm matter; here: slot over the hard maximum.
  for (const s of slots) if (s.durationSec > p.visual.maxShotSec) out.push({ category: "visual", rule: "V_SHOT_TOO_LONG", severity: "major", confidence: 1, startTime: s.startSec, endTime: slotEnd(s), shotId: s.shotId, description: `${s.durationSec} s on one ${s.kind} exceeds ${p.visual.maxShotSec} s`, evidence: { durationSec: s.durationSec, kind: s.kind }, recommendedAction: "split the slot or insert a cutaway" });
  // Semantic evidence from production QA (never inferred from pixels here).
  const SEMANTIC: Record<string, { rule: string; sev: "major" | "blocking"; conf: number; action: string }> = {
    EXTRA_LIMB: { rule: "V_ANATOMY", sev: "blocking", conf: 0.8, action: "regenerate the still" }, DEFORMED: { rule: "V_DEFORMED", sev: "blocking", conf: 0.8, action: "regenerate the still" },
    FACE_CHANGE: { rule: "V_IDENTITY", sev: "blocking", conf: 0.7, action: "regenerate with the character reference" }, CHARACTER_MISMATCH: { rule: "V_IDENTITY", sev: "blocking", conf: 0.7, action: "regenerate with the character reference" },
    CONTINUITY: { rule: "V_CONTINUITY", sev: "major", conf: 0.6, action: "human editorial review" }, INCOHERENT_MOTION: { rule: "V_MOTION_INCOHERENT", sev: "major", conf: 0.6, action: "fall back to still-motion or regenerate" },
  };
  let semanticEvidence = 0;
  for (const s of slots) for (const f of s.qaFindings ?? []) { const m = SEMANTIC[f]; if (!m) continue; semanticEvidence++; out.push({ category: "visual", rule: m.rule, severity: m.sev, confidence: m.conf, startTime: s.startSec, endTime: slotEnd(s), shotId: s.shotId, description: `production QA recorded ${f} on this slot`, evidence: { finding: f, source: "production QA" }, recommendedAction: m.action }); }
  if (!semanticEvidence) na.push("deformed AI images / face changes / anomalous hands (no production QA evidence attached; not detectable from the EDL)");
  return { issues: out, notAssessable: na };
}
