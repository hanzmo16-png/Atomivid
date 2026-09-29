/**
 * Read-only YouTube monitor. One run collects, for a linked video: Data API counters +
 * snippet, Analytics totals for the elapsed windows, audience retention and traffic sources,
 * plus a channel snapshot. Every request is a GET to an allowlisted read endpoint; anything
 * else is refused before the network. The access token is used in memory only.
 */
import { parseTotals, parseRetention, parseTrafficSources, totalsQuery, retentionQuery, trafficSourceQuery, ANALYTICS_REPORTS_URL, DATA_VIDEOS_URL, type MetricRow, type Report } from "./analytics";
import { parseVideoList, videoQuery, type VideoListResponse } from "./video-data";
import { parseChannel, channelQuery, channelTotalsQuery, DATA_CHANNELS_URL, DATA_PLAYLIST_ITEMS_URL, type ChannelListResponse, type ChannelSnapshot } from "./channel-snapshot";
import { windowsFor } from "./time-series";
import type { ProductionLink } from "./link";
import type { VideoObservation } from "./memory";

export const READ_ONLY_ALLOWLIST = [ANALYTICS_REPORTS_URL, DATA_VIDEOS_URL, DATA_CHANNELS_URL, DATA_PLAYLIST_ITEMS_URL] as const;

export class ReadOnlyViolationError extends Error {}

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Wraps fetch so that only GETs to allowlisted read endpoints can ever leave this module. */
export function readOnlyFetch(fetchImpl: Fetch, accessToken: string, calls: string[] = []): Fetch {
  return async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") throw new ReadOnlyViolationError(`${method} ${url} refused: the monitor is read-only`);
    if (!READ_ONLY_ALLOWLIST.some((base) => url.startsWith(base + "?") || url === base)) throw new ReadOnlyViolationError(`${url} is not an allowlisted read endpoint`);
    calls.push(url);
    return fetchImpl(url, { method: "GET", headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${accessToken}` } });
  };
}

export type MonitorRun = {
  linkKey: string; channelId: string; videoId: string; collectedAt: string; title: string | null;
  observation: VideoObservation | null; rows: MetricRow[]; channel: ChannelSnapshot | null;
  windowsCollected: string[]; skipped: string[]; requests: string[];
};

export async function monitorVideo(link: ProductionLink, deps: { fetch: Fetch; accessToken: string; now: string }): Promise<MonitorRun> {
  const calls: string[] = [];
  const get = readOnlyFetch(deps.fetch, deps.accessToken, calls);
  const json = async <T>(url: string): Promise<T | null> => { const r = await get(url); if (!r.ok) return null; return (await r.json()) as T; };
  const rows: MetricRow[] = [];
  const skipped: string[] = [];
  const windowsCollected: string[] = [];
  const day = deps.now.slice(0, 10);

  const video = await json<VideoListResponse>(videoQuery(link.videoId));
  const parsed = video ? parseVideoList(link.channelId, link.videoId, video, deps.now) : { observation: null, rows: [], title: null };
  rows.push(...parsed.rows);
  const publishedAt = parsed.observation?.publishedAt ?? link.publishedAt;
  if (!publishedAt) skipped.push("analytics windows: publishedAt unknown");
  else {
    for (const w of windowsFor(publishedAt, deps.now).filter((x) => x.granularity === "daily")) {
      if (!w.elapsed) { skipped.push(`${w.name}: not elapsed`); continue; }
      const rep = await json<Report>(totalsQuery(link.videoId, w.startDate, w.endDate));
      if (rep) { rows.push(...parseTotals(link.channelId, link.videoId, w.startDate, w.endDate, rep, deps.now)); windowsCollected.push(w.name); } else skipped.push(`${w.name}: analytics unavailable`);
    }
    const start = publishedAt.slice(0, 10);
    const ret = await json<Report>(retentionQuery(link.videoId, start, day));
    if (ret) rows.push(...parseRetention(link.channelId, link.videoId, start, day, ret, deps.now)); else skipped.push("retention: unavailable");
    const ts = await json<Report>(trafficSourceQuery(link.videoId, start, day));
    if (ts) rows.push(...parseTrafficSources(link.channelId, link.videoId, start, day, ts, deps.now)); else skipped.push("traffic sources: unavailable");
  }
  const ch = await json<ChannelListResponse>(channelQuery());
  let channel: ChannelSnapshot | null = null;
  if (ch) {
    const start28 = new Date(Date.parse(deps.now) - 28 * 86400_000).toISOString().slice(0, 10);
    const totals = await json<Report>(channelTotalsQuery(start28, day));
    try { channel = parseChannel(link.channelId, ch, deps.now, totals ? { report: totals, start: start28, end: day } : undefined); } catch (e) { skipped.push(`channel: ${(e as Error).message}`); }
  } else skipped.push("channel: unavailable");
  return { linkKey: link.linkKey, channelId: link.channelId, videoId: link.videoId, collectedAt: deps.now, title: parsed.title, observation: parsed.observation, rows, channel, windowsCollected, skipped, requests: calls };
}
