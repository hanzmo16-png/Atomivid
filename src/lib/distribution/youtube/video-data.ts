/**
 * YouTube Data API v3 (read-only): videos.list snippet/contentDetails/statistics for a
 * video we produced. Public counters (views, likes, comments) are stored as metric rows
 * with source youtube-data-v3; the snippet feeds the per-channel VideoObservation.
 */
import { stableHash } from "@/lib/production-intelligence/canonical";
import { DATA_VIDEOS_URL, type MetricRow } from "./analytics";
import type { VideoObservation } from "./memory";

export function videoQuery(videoId: string): string {
  return `${DATA_VIDEOS_URL}?${new URLSearchParams({ part: "snippet,contentDetails,statistics", id: videoId })}`;
}

export type VideoListResponse = { items?: { id: string; snippet?: { title?: string; publishedAt?: string; channelId?: string; description?: string; tags?: string[] }; contentDetails?: { duration?: string }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }[] };

/** ISO 8601 duration (PT#H#M#S) -> seconds; null when malformed (never guessed). */
export function iso8601DurationSeconds(d: string | undefined): number | null {
  if (!d) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d);
  if (!m) return null;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0));
}

export function parseVideoList(channelId: string, videoId: string, res: VideoListResponse, collectedAt: string): { observation: VideoObservation | null; rows: MetricRow[]; title: string | null } {
  const it = (res.items ?? []).find((x) => x.id === videoId);
  if (!it) return { observation: null, rows: [], title: null };
  if (it.snippet?.channelId && it.snippet.channelId !== channelId) throw new Error(`video ${videoId} belongs to channel ${it.snippet.channelId}, not ${channelId}`);
  const day = collectedAt.slice(0, 10);
  const rows: MetricRow[] = [];
  const stat = (metric: "views" | "likes" | "comments", raw: string | undefined) => {
    if (raw === undefined) return;
    const id = { channelId, videoId, metric, dimensionValue: null, dimensionLabel: null, windowStart: it.snippet?.publishedAt?.slice(0, 10) ?? day, windowEnd: day };
    rows.push({ rowKey: "ytm_" + stableHash(id, 24), ...id, value: Number(raw), source: "youtube-data-v3", collectedAt });
  };
  stat("views", it.statistics?.viewCount); stat("likes", it.statistics?.likeCount); stat("comments", it.statistics?.commentCount);
  return {
    title: it.snippet?.title ?? null,
    observation: { channelId, videoId, publishedAt: it.snippet?.publishedAt ?? null, topic: null, titleStructure: null, thumbnailMetadata: null, durationSeconds: iso8601DurationSeconds(it.contentDetails?.duration), hookStructure: null },
    rows,
  };
}
