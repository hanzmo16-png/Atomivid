/**
 * Mix presets: named production targets ("100% AI motion", "50/50 hybrid", "30/70 economical")
 * expressed as shares of FINISHED SECONDS per visual category, checked deterministically against
 * a planned mix. This is an inspection layer over the Mix Engine (production-intelligence/mix.ts,
 * unchanged): it measures what the plan actually is and reports deviations; it never spends.
 */
import type { Method } from "../production-intelligence/ladder";
import type { ProductionShotRecord } from "./shot-record";

export const MIX_CATEGORIES = ["ai_motion", "real_footage", "animated_stills", "graphics"] as const;
export type MixCategory = (typeof MIX_CATEGORIES)[number];

export type MixPreset = {
  presetId: string;
  label: string;
  /** Target share (0..1) of finished seconds per category; targets sum to 1. */
  targets: Record<MixCategory, number>;
  /** Absolute tolerance per category (share points). */
  tolerance: number;
};

export const MIX_PRESETS: Record<"AI_MOTION_100" | "HYBRID_50_50" | "ECONOMICAL_30_70", MixPreset> = {
  AI_MOTION_100: { presetId: "mix/ai-motion-100", label: "100% AI motion", targets: { ai_motion: 1, real_footage: 0, animated_stills: 0, graphics: 0 }, tolerance: 0.05 },
  HYBRID_50_50: { presetId: "mix/hybrid-50-50", label: "50/50 hybrid (AI motion / real footage)", targets: { ai_motion: 0.5, real_footage: 0.5, animated_stills: 0, graphics: 0 }, tolerance: 0.1 },
  ECONOMICAL_30_70: { presetId: "mix/economical-30-70", label: "30/70 economical (AI motion / stills+footage+graphics)", targets: { ai_motion: 0.3, real_footage: 0.3, animated_stills: 0.3, graphics: 0.1 }, tolerance: 0.15 },
};

/** Category of a planned shot from its record and planned method (never from a prompt). */
export function categoryOf(r: ProductionShotRecord, method: Method | null): MixCategory {
  if (r.assetType === "text" || r.assetType === "diagram" || r.assetType === "map") return "graphics";
  if (method === "I2V_ECONOMY" || method === "I2V_HERO") return "ai_motion";
  if (method === "STOCK" || r.assetType === "stock_video" || (method === "EXISTING_APPROVED_ASSET" && r.contract.existingAssetKind !== "still")) return "real_footage";
  return "animated_stills";
}

export type MixMeasure = { finishedSeconds: number; seconds: Record<MixCategory, number>; share: Record<MixCategory, number>; shots: Record<MixCategory, number> };

export function measureMix(records: ProductionShotRecord[]): MixMeasure {
  const seconds = { ai_motion: 0, real_footage: 0, animated_stills: 0, graphics: 0 };
  const shots = { ai_motion: 0, real_footage: 0, animated_stills: 0, graphics: 0 };
  for (const r of records) { const c = categoryOf(r, r.plannedMethod); seconds[c] += r.durationTargetSec; shots[c] += 1; }
  const finished = Object.values(seconds).reduce((a, b) => a + b, 0);
  const share = Object.fromEntries(MIX_CATEGORIES.map((c) => [c, finished ? Math.round((seconds[c] / finished) * 1000) / 1000 : 0])) as Record<MixCategory, number>;
  return { finishedSeconds: finished, seconds, share, shots };
}

export type MixDeviation = { category: MixCategory; target: number; actual: number; delta: number; withinTolerance: boolean };
export type MixPresetCheck = { presetId: string; pass: boolean; deviations: MixDeviation[]; note: string };

/** Deterministic comparison; a plan outside tolerance is reported, never silently accepted or "fixed". */
export function checkMixPreset(m: MixMeasure, p: MixPreset): MixPresetCheck {
  const deviations = MIX_CATEGORIES.map((c) => { const delta = Math.round((m.share[c] - p.targets[c]) * 1000) / 1000; return { category: c, target: p.targets[c], actual: m.share[c], delta, withinTolerance: Math.abs(delta) <= p.tolerance + 1e-9 }; });
  const pass = deviations.every((d) => d.withinTolerance);
  return { presetId: p.presetId, pass, deviations, note: pass ? `plan matches ${p.label} within ±${p.tolerance}` : `plan deviates from ${p.label}: ${deviations.filter((d) => !d.withinTolerance).map((d) => `${d.category} ${d.actual} vs ${d.target}`).join(", ")}` };
}
