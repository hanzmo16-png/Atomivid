/**
 * QA gate over executor findings. Executors (ffmpeg, OpenCV face counts, visual
 * review) only REPORT findings; this gate maps them to deterministic outcomes.
 * Includes R11: a paid + approved asset intended for the master but absent from
 * the rendered timeline fails QA (a real DULCE Part I bug).
 */
export const QA_CATEGORIES = [
  "GOOD", "DUPLICATION", "IDENTITY_DRIFT", "DEFORMATION", "EXTRA_LIMB", "CHARACTER_APPEARANCE",
  "NARRATIVE_MISMATCH", "PHYSICS_INCONSISTENCY", "UNUSED_PAID_APPROVED_ASSET", "TEXT_SUBTITLE_OVERLAP", "HELD_FRAME",
] as const;
export type QaCategory = (typeof QA_CATEGORIES)[number];

export type QaFinding = {
  category: QaCategory;
  severity: "LOW" | "MEDIUM" | "HIGH";
  scope: "clip" | "master";
  /** Clean window before a clip defect starts (seconds), when a trim can save the clip. */
  usableUntilSeconds?: number | null;
  /** Seconds of held (frozen) frames inserted to fill a slot. */
  heldSeconds?: number;
  humanDetected?: boolean;
  userKept?: boolean;
};

export type GateOutcome = "PASS" | "PASS_WITH_NOTE" | "TRIM" | "FALLBACK" | "FAIL";

/** Deterministic mapping from one finding to a gate outcome. */
export function gateFinding(f: QaFinding, needSeconds?: number): { outcome: GateOutcome; reason: string } {
  switch (f.category) {
    case "GOOD":
      return { outcome: "PASS", reason: "no defect" };
    case "DUPLICATION":
    case "IDENTITY_DRIFT":
    case "DEFORMATION":
    case "EXTRA_LIMB":
    case "CHARACTER_APPEARANCE": // an unwanted figure appears at an onset: the clean window before it is usable (DULCE reviewers recut D01-07, D07-04)
      if (f.usableUntilSeconds != null && needSeconds != null && f.usableUntilSeconds >= needSeconds) return { outcome: "TRIM", reason: `${f.category} after ${f.usableUntilSeconds}s: the clean window covers the slot` };
      return { outcome: "FALLBACK", reason: `${f.category}: clip unusable for the slot; approved still + camera motion (no identical regeneration)` };
    case "NARRATIVE_MISMATCH":
      return { outcome: "FALLBACK", reason: "NARRATIVE_MISMATCH: the picture contradicts the story; fall back instead of re-rolling the same attempt" };
    case "PHYSICS_INCONSISTENCY":
      if (f.severity === "LOW" && f.userKept) return { outcome: "PASS_WITH_NOTE", reason: "LOW physics inconsistency accepted by the user" };
      return { outcome: f.severity === "HIGH" ? "FALLBACK" : "PASS_WITH_NOTE", reason: `physics inconsistency severity ${f.severity}` };
    case "UNUSED_PAID_APPROVED_ASSET":
      return { outcome: "FAIL", reason: "R11: a paid, approved asset intended for the master is missing from the render" };
    case "TEXT_SUBTITLE_OVERLAP":
      return { outcome: "FAIL", reason: "on-screen text collides with subtitles" };
    case "HELD_FRAME":
      return (f.heldSeconds ?? 0) > 0.05 ? { outcome: "FAIL", reason: `${f.heldSeconds}s of held frames in the master` } : { outcome: "PASS", reason: "held time below one frame" };
  }
}

export type IntendedAsset = { assetId: string; paid: boolean; approved: boolean; intendedForMaster: boolean; kind: "clip" | "still" };
export type RenderedSlot = { slotId: string; assetId: string; kind: string };

/** R11 executor: compares what was paid+approved+intended with what the render actually used. */
export function auditUnusedPaidAssets(intended: IntendedAsset[], rendered: RenderedSlot[]): QaFinding[] {
  return intended
    .filter((a) => a.paid && a.approved && a.intendedForMaster)
    .filter((a) => !rendered.some((s) => s.assetId === a.assetId && s.kind === a.kind))
    .map((): QaFinding => ({ category: "UNUSED_PAID_APPROVED_ASSET", severity: "HIGH", scope: "master" }));
}

export function gateMaster(findings: QaFinding[]): { pass: boolean; outcomes: { category: QaCategory; outcome: GateOutcome; reason: string }[] } {
  const outcomes = findings.map((f) => ({ category: f.category, ...gateFinding(f) }));
  return { pass: outcomes.every((o) => o.outcome === "PASS" || o.outcome === "PASS_WITH_NOTE"), outcomes };
}
