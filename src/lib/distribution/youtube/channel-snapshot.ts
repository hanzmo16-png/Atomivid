/**
 * Channel-level read-only snapshot: subscribers / total views / video count from
 * channels.list (Data API v3), watch time from the Analytics API channel totals, and the
 * publishing history from the uploads playlist. Each snapshot is a point in time; the
 * series is what allows 24h/48h/7d/28d comparisons later.
 */
import { stableHash } from "@/lib/production-intelligence/canonical";
import { ANALYTICS_REPORTS_URL, type Report } from "./analytics";

export const DATA_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
export const DATA_PLAYLIST_ITEMS_URL = "https://www.googleapis.com/youtube/v3/playlistItems";

export type ChannelSnapshot = {
  snapshotKey: string;
  channelId: string;
  collectedAt: string;
  subscribers: number | null;
  totalViews: number | null;
  videoCount: number | null;
  /** Channel watch time (minutes) over [windowStart, windowEnd]; null when the analytics call was not made. */
  watchTimeMinutes: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  uploadsPlaylistId: string | null;
};

export type PublishedVideo = { channelId: string; videoId: string; title: string; publishedAt: string };

export const channelQuery = () => `${DATA_CHANNELS_URL}?${new URLSearchParams({ part: "statistics,contentDetails", mine: "true" })}`;
export const channelTotalsQuery = (start: string, end: string) => `${ANALYTICS_REPORTS_URL}?${new URLSearchParams({ ids: "channel==MINE", startDate: start, endDate: end, metrics: "estimatedMinutesWatched,views,subscribersGained,subscribersLost" })}`;
export const uploadsQuery = (playlistId: string, pageToken?: string) => `${DATA_PLAYLIST_ITEMS_URL}?${new URLSearchParams({ part: "snippet,contentDetails", playlistId, maxResults: "50", ...(pageToken ? { pageToken } : {}) })}`;

export type ChannelListResponse = { items?: { id: string; statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] };
export type PlaylistItemsResponse = { nextPageToken?: string; items?: { snippet?: { title?: string; publishedAt?: string; resourceId?: { videoId?: string } }; contentDetails?: { videoId?: string; videoPublishedAt?: string } }[] };

export function parseChannel(channelId: string, res: ChannelListResponse, collectedAt: string, totals?: { report: Report; start: string; end: string }): ChannelSnapshot {
  const it = (res.items ?? []).find((x) => x.id === channelId);
  if (!it) throw new Error(`channel ${channelId} not in the authenticated account's channels.list`);
  const n = (v: string | undefined) => (v === undefined ? null : Number(v));
  let watch: number | null = null;
  if (totals) {
    const cols = totals.report.columnHeaders.map((c) => c.name), i = cols.indexOf("estimatedMinutesWatched");
    const row = totals.report.rows?.[0];
    if (i >= 0 && row && typeof row[i] === "number") watch = row[i] as number;
  }
  const body = { channelId, collectedAt, subscribers: it.statistics?.hiddenSubscriberCount ? null : n(it.statistics?.subscriberCount), totalViews: n(it.statistics?.viewCount), videoCount: n(it.statistics?.videoCount), watchTimeMinutes: watch, windowStart: totals?.start ?? null, windowEnd: totals?.end ?? null, uploadsPlaylistId: it.contentDetails?.relatedPlaylists?.uploads ?? null };
  return { snapshotKey: "ytc_" + stableHash({ channelId, collectedAt }, 24), ...body };
}

export function parseUploads(channelId: string, res: PlaylistItemsResponse): PublishedVideo[] {
  return (res.items ?? []).flatMap((it) => {
    const videoId = it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId, publishedAt = it.contentDetails?.videoPublishedAt ?? it.snippet?.publishedAt;
    return videoId && publishedAt ? [{ channelId, videoId, title: it.snippet?.title ?? "", publishedAt }] : [];
  });
}
