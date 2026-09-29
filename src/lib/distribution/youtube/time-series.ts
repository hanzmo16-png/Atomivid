/**
 * Time-series windows relative to a video's publication: 24h, 48h, 7d, 28d. A window is
 * "available" only when it has fully elapsed AND the Analytics API day-granularity data
 * can cover it (analytics reports are per calendar day, so sub-day windows are compared
 * through Data API snapshots taken at those offsets, never through invented hourly data).
 */
import type { MetricRow } from "./analytics";

export const WINDOWS = { "24h": 24, "48h": 48, "7d": 24 * 7, "28d": 24 * 28 } as const;
export type WindowName = keyof typeof WINDOWS;

export type Window = { name: WindowName; startIso: string; endIso: string; startDate: string; endDate: string; elapsed: boolean; granularity: "snapshot" | "daily" };

export function windowsFor(publishedAt: string, now: string): Window[] {
  const p = Date.parse(publishedAt), n = Date.parse(now);
  return (Object.keys(WINDOWS) as WindowName[]).map((name) => {
    const end = p + WINDOWS[name] * 3600_000;
    const s = new Date(p).toISOString(), e = new Date(end).toISOString();
    return { name, startIso: s, endIso: e, startDate: s.slice(0, 10), endDate: e.slice(0, 10), elapsed: n >= end, granularity: WINDOWS[name] < 24 * 7 ? "snapshot" : "daily" };
  });
}

/** Snapshot rows (Data API counters) closest to each window end, within a tolerance; null when no snapshot is close enough. */
export function snapshotAtWindow(rows: MetricRow[], metric: MetricRow["metric"], w: Window, toleranceHours = 3): MetricRow | null {
  const target = Date.parse(w.endIso);
  const cands = rows.filter((r) => r.metric === metric && r.source === "youtube-data-v3" && r.dimensionValue === null && Math.abs(Date.parse(r.collectedAt) - target) <= toleranceHours * 3600_000);
  if (!cands.length) return null;
  return cands.sort((a, b) => Math.abs(Date.parse(a.collectedAt) - target) - Math.abs(Date.parse(b.collectedAt) - target))[0];
}

export type WindowComparison = { metric: MetricRow["metric"]; windows: Record<WindowName, number | null>; note: string };

/** Compare a counter across the standard windows. Missing data stays null; nothing is interpolated. */
export function compareWindows(rows: MetricRow[], metric: MetricRow["metric"], publishedAt: string, now: string): WindowComparison {
  const ws = windowsFor(publishedAt, now);
  const out = {} as Record<WindowName, number | null>;
  for (const w of ws) {
    if (!w.elapsed) { out[w.name] = null; continue; }
    if (w.granularity === "snapshot") { out[w.name] = snapshotAtWindow(rows, metric, w)?.value ?? null; continue; }
    // Daily analytics: a totals row whose window matches [publish day, window end day].
    const hit = rows.find((r) => r.metric === metric && r.source === "youtube-analytics-v2" && r.dimensionValue === null && !r.dimensionLabel && r.windowStart === w.startDate && r.windowEnd === w.endDate);
    out[w.name] = hit?.value ?? null;
  }
  return { metric, windows: out, note: "null = window not elapsed or no observation close enough; values are never interpolated" };
}
