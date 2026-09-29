/**
 * Generic experiment model: one row per published video joining YOUTUBE performance with
 * PRODUCTION facts, so the first videos can be compared later by a person. No project name,
 * no learning, no write path into Production Intelligence: this module only assembles data
 * that other modules already record. Unknown stays null (never 0).
 */
import type { PerformanceSnapshot } from "./snapshots";
import type { MetricRow } from "./analytics";
import type { ProductionLink } from "./link";
import type { WindowName } from "./time-series";

export type YouTubeSide = {
  views: number | null; watchTimeMinutes: number | null; averageViewDurationSeconds: number | null; averagePercentageViewed: number | null;
  subscribersGained: number | null; subscribersLost: number | null;
  /** audienceWatchRatio at the elapsed ratio closest to 30 s of the video, when retention rows exist. */
  retentionAt30s: number | null;
  trafficSources: Record<string, number> | null;
  /** Only from a valid manual/external source; null otherwise. */
  impressions: number | null; impressionsCtr: number | null; ctrSource: "manual_entry" | null;
};
export type ProductionSide = {
  productionCostUsd: number | null; providerCostUsd: Record<string, number> | null;
  openingShotDensity: number | null; averageShotSec: number | null; movementDensity: number | null; stillStreakSec: number | null;
  finalCutIssues: number | null; repairCount: number | null; renderDurationSec: number | null; providerMix: Record<string, number> | null;
};
export type ExperimentRow = { productionId: string; videoId: string; channelId: string; publishedAt: string | null; window: WindowName; youtube: YouTubeSide; production: ProductionSide; note: string };

export type ProductionFacts = { productionId: string; costReport?: { cogsUsd: number; byProvider: Record<string, { actualUsd: number }> } | null; finalCutMetrics?: { opening?: { shotCount?: number; averageShotSec?: number | null; movementDensity?: number | null; stillStreakMaxSec?: number }; editorial?: { averageShotSec?: number | null; motionDensity?: number | null } } | null; finalCutIssueCount?: number | null; repairCount?: number | null; renderDurationSec?: number | null; providerMix?: Record<string, number> | null };

export function experimentRow(link: ProductionLink, window: WindowName, snapshots: PerformanceSnapshot[], rows: MetricRow[], facts: ProductionFacts | null, videoDurationSec: number | null): ExperimentRow {
  const snap = snapshots.find((s) => s.videoId === link.videoId && s.window === window && (s.status === "COLLECTED" || s.status === "PARTIAL"));
  const m = snap?.metrics ?? {};
  const n = (k: keyof typeof m) => (typeof m[k] === "number" ? (m[k] as number) : null);
  const ret = rows.filter((r) => r.videoId === link.videoId && r.metric === "audienceWatchRatio" && r.dimensionValue !== null);
  let retentionAt30s: number | null = null;
  if (ret.length && videoDurationSec && videoDurationSec > 0) { const target = Math.min(1, 30 / videoDurationSec); retentionAt30s = ret.reduce((best, r) => (Math.abs((r.dimensionValue ?? 0) - target) < Math.abs((best.dimensionValue ?? 0) - target) ? r : best)).value; }
  const traffic = rows.filter((r) => r.videoId === link.videoId && r.metric === "views" && r.dimensionLabel);
  const manual = (metric: "impressions" | "impressionsCtr") => rows.filter((r) => r.videoId === link.videoId && r.metric === metric && r.source === "manual_entry").sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))[0]?.value ?? null;
  const imp = manual("impressions"), ctr = manual("impressionsCtr");
  const fc = facts?.finalCutMetrics ?? null;
  return {
    productionId: link.projectId, videoId: link.videoId, channelId: link.channelId, publishedAt: link.publishedAt, window,
    youtube: { views: n("views"), watchTimeMinutes: n("watchTimeMinutes"), averageViewDurationSeconds: n("averageViewDurationSeconds"), averagePercentageViewed: n("averagePercentageViewed"), subscribersGained: n("subscribersGained"), subscribersLost: n("subscribersLost"), retentionAt30s, trafficSources: traffic.length ? Object.fromEntries(traffic.map((r) => [r.dimensionLabel!, r.value])) : null, impressions: imp, impressionsCtr: ctr, ctrSource: ctr !== null ? "manual_entry" : null },
    production: { productionCostUsd: facts?.costReport?.cogsUsd ?? null, providerCostUsd: facts?.costReport ? Object.fromEntries(Object.entries(facts.costReport.byProvider).map(([p, a]) => [p, a.actualUsd])) : null, openingShotDensity: fc?.opening?.shotCount !== undefined ? fc.opening.shotCount / 30 : null, averageShotSec: fc?.editorial?.averageShotSec ?? null, movementDensity: fc?.editorial?.motionDensity ?? fc?.opening?.movementDensity ?? null, stillStreakSec: fc?.opening?.stillStreakMaxSec ?? null, finalCutIssues: facts?.finalCutIssueCount ?? null, repairCount: facts?.repairCount ?? null, renderDurationSec: facts?.renderDurationSec ?? null, providerMix: facts?.providerMix ?? null },
    note: "observational; null = not available; this table never changes Production Intelligence",
  };
}
