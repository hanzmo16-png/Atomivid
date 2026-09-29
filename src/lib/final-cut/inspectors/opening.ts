/**
 * Opening / hook inspection: metrics over the first N seconds, judged only against the
 * configurable opening policy (no built-in notion of "good"). Metrics are always returned;
 * issues fire only where a policy bound is crossed.
 */
import { slotEnd, slotsSorted, r2, type MasterEdl } from "../edl";
import type { FinalCutPolicy } from "../policy";
import type { IssueDraft, OpeningMetrics } from "../report";

export function inspectOpening(e: MasterEdl, p: FinalCutPolicy): { metrics: OpeningMetrics; issues: IssueDraft[] } {
  const W = Math.min(p.opening.windowSec, e.durationSec);
  const inWin = slotsSorted(e).filter((s) => s.startSec < W);
  const clip = (s: (typeof inWin)[number]) => r2(Math.min(slotEnd(s), W) - s.startSec);
  const shotCount = inWin.length;
  const avg = shotCount ? r2(inWin.reduce((t, s) => t + clip(s), 0) / shotCount) : null;
  const moving = inWin.reduce((t, s) => t + (s.motion === "static" ? 0 : clip(s)), 0);
  const movementDensity = W > 0 && shotCount ? r2(moving / W) : null;
  let streak = 0, streakMax = 0;
  for (const s of inWin) { if (s.motion === "static") { streak += clip(s); streakMax = Math.max(streakMax, streak); } else streak = 0; }
  const blackSec = e.measured.blackIntervals ? r2(e.measured.blackIntervals.reduce((t, b) => t + Math.max(0, Math.min(b.endSec, W) - Math.max(b.startSec, 0)), 0)) : (inWin.some((s) => s.kind === "black") ? r2(inWin.filter((s) => s.kind === "black").reduce((t, s) => t + clip(s), 0)) : null);
  const titleCardSec = r2(inWin.filter((s) => s.kind === "text_card").reduce((t, s) => t + clip(s), 0));
  const keys = inWin.map((s) => s.visualKey);
  const visualRepetitions = keys.length - new Set(keys).size;
  const metrics: OpeningMetrics = { windowSec: W, shotCount, averageShotSec: avg, movementDensity, stillStreakMaxSec: r2(streakMax), blackSec, titleCardSec, visualRepetitions, assessable: shotCount > 0 };
  const issues: IssueDraft[] = [];
  const range = { startTime: 0, endTime: W, shotId: null };
  if (!metrics.assessable) return { metrics, issues };
  const push = (rule: string, severity: IssueDraft["severity"], description: string, evidence: Record<string, unknown>, recommendedAction: string) => issues.push({ category: "opening", rule, severity, confidence: e.source.kind === "media" ? 0.7 : 0.95, ...range, description, evidence, recommendedAction });
  if (shotCount < p.opening.minShotCount) push("O_SHOT_COUNT", "major", `${shotCount} shots in the first ${W} s (policy minimum ${p.opening.minShotCount})`, { shotCount }, "add cuts in the opening");
  if (avg !== null && avg > p.opening.maxAvgShotSec) push("O_AVG_SHOT", "major", `average opening shot ${avg} s (policy maximum ${p.opening.maxAvgShotSec} s)`, { averageShotSec: avg }, "shorten opening shots");
  if (movementDensity !== null && movementDensity < p.opening.minMovementDensity) push("O_MOVEMENT_DENSITY", "major", `movement density ${movementDensity} in the opening (policy minimum ${p.opening.minMovementDensity})`, { movementDensity }, "add moving slots to the opening");
  if (streakMax > p.opening.maxStillStreakSec) push("O_STILL_STREAK", "major", `${r2(streakMax)} s still-image streak in the opening (policy maximum ${p.opening.maxStillStreakSec} s)`, { stillStreakMaxSec: r2(streakMax) }, "break the streak with motion");
  if (blackSec !== null && blackSec > p.opening.maxBlackSec) push("O_BLACK", "major", `${blackSec} s of black in the opening`, { blackSec }, "trim opening black");
  if (titleCardSec > p.opening.maxTitleCardSec) push("O_TITLE_CARD", "major", `${titleCardSec} s of title/text cards in the opening (policy maximum ${p.opening.maxTitleCardSec} s)`, { titleCardSec }, "shorten the title card");
  if (visualRepetitions > 0) push("O_REPETITION", "minor", `${visualRepetitions} repeated visual(s) inside the opening`, { visualRepetitions }, "substitute repeated visuals");
  return { metrics, issues };
}
