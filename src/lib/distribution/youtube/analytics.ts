/**
 * YouTube Analytics ingestion (official YouTube Analytics API v2 + Data API v3).
 * Only metrics the API actually exposes are mapped; nothing is invented.
 * Rows are idempotent: the same (channel, video, metric, window, dimension) key
 * always overwrites the same observation instead of duplicating it.
 */
import { stableHash } from "@/lib/production-intelligence/canonical";

export const ANALYTICS_REPORTS_URL = "https://youtubeanalytics.googleapis.com/v2/reports";
export const DATA_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

/** Our metric name -> official API metric name. */
export const METRIC_MAP = {
  views: "views",
  watchTimeMinutes: "estimatedMinutesWatched",
  averageViewDurationSeconds: "averageViewDuration",
  likes: "likes",
  comments: "comments",
  shares: "shares",
  subscribersGained: "subscribersGained",
  subscribersLost: "subscribersLost",
} as const;
export type MetricName = keyof typeof METRIC_MAP | "audienceWatchRatio";

export type MetricRow = {
  rowKey: string;
  channelId: string;
  videoId: string;
  metric: MetricName;
  value: number;
  /** For retention: elapsedVideoTimeRatio (0..1); null for totals. */
  dimensionValue: number | null;
  windowStart: string;
  windowEnd: string;
  source: "youtube-analytics-v2" | "youtube-data-v3";
  collectedAt: string;
};

export function totalsQuery(videoId: string, start: string, end: string): string {
  return `${ANALYTICS_REPORTS_URL}?${new URLSearchParams({ ids: "channel==MINE", startDate: start, endDate: end, metrics: Object.values(METRIC_MAP).join(","), dimensions: "video", filters: `video==${videoId}` })}`;
}

export function retentionQuery(videoId: string, start: string, end: string): string {
  return `${ANALYTICS_REPORTS_URL}?${new URLSearchParams({ ids: "channel==MINE", startDate: start, endDate: end, metrics: "audienceWatchRatio", dimensions: "elapsedVideoTimeRatio", filters: `video==${videoId}` })}`;
}

type Report = { columnHeaders: { name: string }[]; rows?: (string | number)[][] };

const key = (r: Omit<MetricRow, "rowKey" | "value" | "collectedAt" | "source">) => "ytm_" + stableHash(r, 24);

/** Parse a totals report (dimension=video) into metric rows. Unknown columns are ignored. */
export function parseTotals(channelId: string, videoId: string, start: string, end: string, report: Report, collectedAt: string): MetricRow[] {
  const cols = report.columnHeaders.map((c) => c.name);
  const reverse = Object.fromEntries(Object.entries(METRIC_MAP).map(([ours, api]) => [api, ours])) as Record<string, MetricName>;
  const out: MetricRow[] = [];
  for (const row of report.rows ?? []) {
    if (row[cols.indexOf("video")] !== videoId) continue;
    cols.forEach((c, i) => {
      const metric = reverse[c];
      if (!metric || typeof row[i] !== "number") return;
      const id = { channelId, videoId, metric, dimensionValue: null, windowStart: start, windowEnd: end };
      out.push({ rowKey: key(id), ...id, value: row[i] as number, source: "youtube-analytics-v2", collectedAt });
    });
  }
  return out;
}

export function parseRetention(channelId: string, videoId: string, start: string, end: string, report: Report, collectedAt: string): MetricRow[] {
  const cols = report.columnHeaders.map((c) => c.name);
  const x = cols.indexOf("elapsedVideoTimeRatio"), y = cols.indexOf("audienceWatchRatio");
  if (x < 0 || y < 0) return [];
  return (report.rows ?? []).map((r) => {
    const id = { channelId, videoId, metric: "audienceWatchRatio" as const, dimensionValue: Number(r[x]), windowStart: start, windowEnd: end };
    return { rowKey: key(id), ...id, value: Number(r[y]), source: "youtube-analytics-v2" as const, collectedAt };
  });
}

/** Idempotent upsert into an in-memory map keyed by rowKey (the DB table uses the same unique key). */
export function upsertRows(store: Map<string, MetricRow>, rows: MetricRow[]): { inserted: number; updated: number } {
  let inserted = 0, updated = 0;
  for (const r of rows) { if (store.has(r.rowKey)) updated++; else inserted++; store.set(r.rowKey, r); }
  return { inserted, updated };
}
