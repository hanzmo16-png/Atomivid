/**
 * Performance snapshots at T+24h, T+48h, T+7d and T+28d after publication. A snapshot is
 * content-addressed by (channel, video, window): collecting twice never duplicates it, and a
 * COLLECTED snapshot is never re-collected. A window that has not elapsed is NOT_DUE; a run
 * that failed keeps the snapshot open (PENDING with the failure) so the next scheduler pass
 * retries it. Nothing is interpolated or estimated.
 */
import { stableHash } from "@/lib/production-intelligence/canonical";
import { windowsFor, type WindowName, type Window } from "./time-series";
import type { MetricRow } from "./analytics";
import type { MonitorRun } from "./monitor";

export type SnapshotStatus = "NOT_DUE" | "PENDING" | "COLLECTED" | "PARTIAL" | "UNAVAILABLE";
export type PerformanceSnapshot = {
  snapshotKey: string;
  channelId: string;
  videoId: string;
  window: WindowName;
  dueAt: string;
  status: SnapshotStatus;
  collectedAt: string | null;
  /** Totals for the window (analytics) or the closest Data API counter (24h/48h). */
  metrics: Partial<Record<MetricRow["metric"], number>>;
  source: "youtube-analytics-v2" | "youtube-data-v3" | null;
  lastFailure: string | null;
  attempts: number;
};

export const snapshotKey = (channelId: string, videoId: string, window: WindowName) => "yts_" + stableHash({ channelId, videoId, window }, 24);

/** The four snapshot slots for a video, all NOT_DUE/PENDING according to `now`. */
export function plannedSnapshots(channelId: string, videoId: string, publishedAt: string, now: string): PerformanceSnapshot[] {
  return windowsFor(publishedAt, now).map((w) => ({ snapshotKey: snapshotKey(channelId, videoId, w.name), channelId, videoId, window: w.name, dueAt: w.endIso, status: w.elapsed ? "PENDING" : "NOT_DUE", collectedAt: null, metrics: {}, source: null, lastFailure: null, attempts: 0 }));
}

/**
 * Fill due snapshots from one monitor run. Returns the updated set; existing COLLECTED
 * snapshots are returned untouched (idempotent), NOT_DUE ones stay closed, failures are recorded.
 */
export function applyRun(existing: PerformanceSnapshot[], run: MonitorRun, publishedAt: string): PerformanceSnapshot[] {
  const windows = windowsFor(publishedAt, run.collectedAt);
  const byName = new Map(windows.map((w) => [w.name, w]));
  const planned = plannedSnapshots(run.channelId, run.videoId, publishedAt, run.collectedAt);
  const current = new Map(existing.map((s) => [s.snapshotKey, s]));
  return planned.map((p) => {
    const prev = current.get(p.snapshotKey);
    if (prev?.status === "COLLECTED") return prev;
    const w = byName.get(p.window)!;
    if (!w.elapsed) return prev ?? p;
    const attempts = (prev?.attempts ?? 0) + 1;
    const fromRun = metricsForWindow(run.rows, w);
    if (run.outcome === "VIDEO_MISSING") return { ...p, status: "UNAVAILABLE", attempts, lastFailure: "video missing (deleted or not owned)" };
    if (fromRun) return { ...p, status: fromRun.partial ? "PARTIAL" : "COLLECTED", collectedAt: run.collectedAt, metrics: fromRun.metrics, source: fromRun.source, attempts, lastFailure: null };
    const failure = run.failures.length ? run.failures.map((f) => `${f.step}:${f.kind}`).join(", ") : "analytics not available yet for this window";
    return { ...p, status: "PENDING", attempts, lastFailure: failure, metrics: prev?.metrics ?? {}, source: prev?.source ?? null };
  });
}

function metricsForWindow(rows: MetricRow[], w: Window): { metrics: PerformanceSnapshot["metrics"]; source: PerformanceSnapshot["source"]; partial: boolean } | null {
  if (w.granularity === "daily") {
    const hit = rows.filter((r) => r.source === "youtube-analytics-v2" && r.dimensionValue === null && !r.dimensionLabel && r.windowStart === w.startDate && r.windowEnd === w.endDate);
    if (!hit.length) return null;
    const metrics = Object.fromEntries(hit.map((r) => [r.metric, r.value])) as PerformanceSnapshot["metrics"];
    return { metrics, source: "youtube-analytics-v2", partial: !("views" in metrics && "watchTimeMinutes" in metrics) };
  }
  // 24h / 48h: the Data API counter closest to the window end, within 3 h.
  const target = Date.parse(w.endIso);
  const cands = rows.filter((r) => r.source === "youtube-data-v3" && r.dimensionValue === null && Math.abs(Date.parse(r.collectedAt) - target) <= 3 * 3600_000);
  if (!cands.length) return null;
  const metrics = Object.fromEntries(cands.map((r) => [r.metric, r.value])) as PerformanceSnapshot["metrics"];
  return { metrics, source: "youtube-data-v3", partial: !("views" in metrics) };
}

/** Which windows a scheduler must still collect (PENDING and due). */
export const dueSnapshots = (s: PerformanceSnapshot[], now: string) => s.filter((x) => x.status === "PENDING" && Date.parse(x.dueAt) <= Date.parse(now));
