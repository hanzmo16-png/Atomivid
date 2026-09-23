import type { LongFormMode } from "./types";

export function targetDurationRange(mode: LongFormMode): { minSec: number; maxSec: number } {
  if (mode === "curiosity_documentary") return { minSec: 8 * 60, maxSec: 12 * 60 };
  return { minSec: 10 * 60, maxSec: 16 * 60 };
}

export function clampTargetDuration(mode: LongFormMode, requestedSec?: number): number {
  const { minSec, maxSec } = targetDurationRange(mode);
  if (!requestedSec || !Number.isFinite(requestedSec)) return Math.round((minSec + maxSec) / 2);
  return Math.min(maxSec, Math.max(minSec, Math.round(requestedSec)));
}

export function visualHoldSeconds(beatType: string, narrationWordCount: number): number {
  const spoken = Math.max(3, Math.round((narrationWordCount / 150) * 60));
  if (beatType === "hook") return Math.min(6, Math.max(3, spoken));
  return Math.min(8, Math.max(4, spoken));
}
