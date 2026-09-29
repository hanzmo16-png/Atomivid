/**
 * Read-only YouTube monitor. One run collects, for a linked video: Data API counters +
 * snippet, Analytics totals for the elapsed windows, audience retention and traffic sources,
 * plus a channel snapshot. Every request is a GET to an allowlisted read endpoint; anything
 * else is refused before the network. The access token is used in memory only.
 * Failures are CLASSIFIED (token expired, quota, rate limit, video missing, API down) and
 * reported per step; a run never invents a metric for a step that failed.
 */
import { parseTotals, parseRetention, parseTrafficSources, totalsQuery, retentionQuery, trafficSourceQuery, ANALYTICS_REPORTS_URL, DATA_VIDEOS_URL, type MetricRow, type Report } from "./analytics";
import { parseVideoList, videoQuery, type VideoListResponse } from "./video-data";
import { parseChannel, channelQuery, channelTotalsQuery, DATA_CHANNELS_URL, DATA_PLAYLIST_ITEMS_URL, type ChannelListResponse, type ChannelSnapshot } from "./channel-snapshot";
import { windowsFor } from "./time-series";
import type { ProductionLink } from "./link";
import type { VideoObservation } from "./memory";

export const READ_ONLY_ALLOWLIST = [ANALYTICS_REPORTS_URL, DATA_VIDEOS_URL, DATA_CHANNELS_URL, DATA_PLAYLIST_ITEMS_URL] as const;

export class ReadOnlyViolationError extends Error {}

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; headers?: { get(name: string): string | null } }>;

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

export type FailureKind = "TOKEN_EXPIRED" | "QUOTA_EXCEEDED" | "RATE_LIMITED" | "FORBIDDEN" | "NOT_FOUND" | "API_UNAVAILABLE" | "NETWORK";
export type StepFailure = { step: string; kind: FailureKind; httpStatus: number | null; retryable: boolean; retryAfterSeconds: number | null };

/** Classify an HTTP answer from Google APIs (reason strings per the official error format). */
export async function classifyFailure(step: string, r: { status: number; json(): Promise<unknown>; headers?: { get(name: string): string | null } }): Promise<StepFailure> {
  let reason = "";
  try { const j = (await r.json()) as { error?: { errors?: { reason?: string }[]; status?: string } }; reason = j?.error?.errors?.[0]?.reason ?? j?.error?.status ?? ""; } catch { /* no body */ }
  const retryAfter = r.headers?.get?.("retry-after"); const ra = retryAfter ? Number(retryAfter) : null;
  if (r.status === 401) return { step, kind: "TOKEN_EXPIRED", httpStatus: 401, retryable: true, retryAfterSeconds: null };
  if (r.status === 403 && /quota/i.test(reason)) return { step, kind: "QUOTA_EXCEEDED", httpStatus: 403, retryable: true, retryAfterSeconds: ra ?? 24 * 3600 };
  if (r.status === 429 || /rateLimit|userRateLimit/i.test(reason)) return { step, kind: "RATE_LIMITED", httpStatus: r.status, retryable: true, retryAfterSeconds: ra ?? 60 };
  if (r.status === 403) return { step, kind: "FORBIDDEN", httpStatus: 403, retryable: false, retryAfterSeconds: null };
  if (r.status === 404) return { step, kind: "NOT_FOUND", httpStatus: 404, retryable: false, retryAfterSeconds: null };
  if (r.status >= 500) return { step, kind: "API_UNAVAILABLE", httpStatus: r.status, retryable: true, retryAfterSeconds: ra ?? 300 };
  return { step, kind: "FORBIDDEN", httpStatus: r.status, retryable: false, retryAfterSeconds: null };
}

export type VideoState = "PUBLIC" | "UNLISTED" | "PRIVATE" | "MISSING" | "UNKNOWN";
export type MonitorOutcome = "COMPLETE" | "PARTIAL" | "NOT_DUE" | "VIDEO_MISSING" | "TOKEN_EXPIRED" | "QUOTA_EXCEEDED" | "RATE_LIMITED" | "API_UNAVAILABLE" | "FAILED";

export type MonitorRun = {
  linkKey: string; channelId: string; videoId: string; collectedAt: string; title: string | null;
  videoState: VideoState;
  observation: VideoObservation | null; rows: MetricRow[]; channel: ChannelSnapshot | null;
  windowsCollected: string[]; windowsNotDue: string[]; skipped: string[]; failures: StepFailure[]; requests: string[];
  outcome: MonitorOutcome;
};

/**
 * `refreshToken` (optional): called once when the first request answers 401; the run continues with the
 * new token. Without it, a 401 ends the run as TOKEN_EXPIRED (nothing collected after that point).
 */
export async function monitorVideo(link: ProductionLink, deps: { fetch: Fetch; accessToken: string; now: string; refreshToken?: () => Promise<string> }): Promise<MonitorRun> {
  const calls: string[] = [];
  let token = deps.accessToken;
  let get = readOnlyFetch(deps.fetch, token, calls);
  const failures: StepFailure[] = [];
  let refreshed = false;
  const json = async <T>(step: string, url: string): Promise<T | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try { r = await get(url); } catch (e) { if (e instanceof ReadOnlyViolationError) throw e; failures.push({ step, kind: "NETWORK", httpStatus: null, retryable: true, retryAfterSeconds: 60 }); return null; }
      if (r.ok) return (await r.json()) as T;
      const f = await classifyFailure(step, r);
      if (f.kind === "TOKEN_EXPIRED" && deps.refreshToken && !refreshed) { refreshed = true; token = await deps.refreshToken(); get = readOnlyFetch(deps.fetch, token, calls); continue; }
      failures.push(f); return null;
    }
    return null;
  };
  const rows: MetricRow[] = [];
  const skipped: string[] = [];
  const windowsCollected: string[] = [], windowsNotDue: string[] = [];
  const day = deps.now.slice(0, 10);
  let videoState: VideoState = "UNKNOWN";

  const video = await json<VideoListResponse & { items?: { status?: { privacyStatus?: string } }[] }>("video", videoQuery(link.videoId));
  const parsed = video ? parseVideoList(link.channelId, link.videoId, video, deps.now) : { observation: null, rows: [], title: null };
  if (video) {
    const item = (video.items ?? []).find((x) => (x as { id?: string }).id === link.videoId) as { status?: { privacyStatus?: string } } | undefined;
    videoState = !item ? "MISSING" : item.status?.privacyStatus === "private" ? "PRIVATE" : item.status?.privacyStatus === "unlisted" ? "UNLISTED" : item.status?.privacyStatus === "public" ? "PUBLIC" : "UNKNOWN";
    if (!item) skipped.push("video: not returned by videos.list (deleted or not owned)");
  }
  rows.push(...parsed.rows);
  const publishedAt = parsed.observation?.publishedAt ?? link.publishedAt;
  if (videoState !== "MISSING") {
    if (!publishedAt) skipped.push("analytics windows: publishedAt unknown");
    else {
      for (const w of windowsFor(publishedAt, deps.now).filter((x) => x.granularity === "daily")) {
        if (!w.elapsed) { windowsNotDue.push(w.name); continue; }
        const rep = await json<Report>(`totals:${w.name}`, totalsQuery(link.videoId, w.startDate, w.endDate));
        if (rep) { const parsedRows = parseTotals(link.channelId, link.videoId, w.startDate, w.endDate, rep, deps.now); rows.push(...parsedRows); if (parsedRows.length) windowsCollected.push(w.name); else skipped.push(`${w.name}: analytics report empty (not available yet)`); }
      }
      const start = publishedAt.slice(0, 10);
      const ret = await json<Report>("retention", retentionQuery(link.videoId, start, day));
      if (ret) { const r = parseRetention(link.channelId, link.videoId, start, day, ret, deps.now); rows.push(...r); if (!r.length) skipped.push("retention: no rows yet"); }
      const ts = await json<Report>("traffic", trafficSourceQuery(link.videoId, start, day));
      if (ts) { const r = parseTrafficSources(link.channelId, link.videoId, start, day, ts, deps.now); rows.push(...r); if (!r.length) skipped.push("traffic sources: no rows yet"); }
    }
  }
  const ch = await json<ChannelListResponse>("channel", channelQuery());
  let channel: ChannelSnapshot | null = null;
  if (ch) {
    const start28 = new Date(Date.parse(deps.now) - 28 * 86400_000).toISOString().slice(0, 10);
    const totals = await json<Report>("channel-totals", channelTotalsQuery(start28, day));
    try { channel = parseChannel(link.channelId, ch, deps.now, totals ? { report: totals, start: start28, end: day } : undefined); } catch (e) { skipped.push(`channel: ${(e as Error).message}`); }
  }
  // Outcome: the most restrictive failure decides; partial data is still persisted by the caller.
  const kinds = new Set(failures.map((f) => f.kind));
  const outcome: MonitorOutcome = videoState === "MISSING" ? "VIDEO_MISSING"
    : kinds.has("TOKEN_EXPIRED") && !rows.length ? "TOKEN_EXPIRED"
    : kinds.has("QUOTA_EXCEEDED") && !rows.length ? "QUOTA_EXCEEDED"
    : kinds.has("RATE_LIMITED") && !rows.length ? "RATE_LIMITED"
    : (kinds.has("API_UNAVAILABLE") || kinds.has("NETWORK")) && !rows.length ? "API_UNAVAILABLE"
    : failures.length ? "PARTIAL"
    : !windowsCollected.length && windowsNotDue.length && !rows.some((r) => r.source === "youtube-analytics-v2") ? "NOT_DUE"
    : rows.length ? "COMPLETE" : "FAILED";
  return { linkKey: link.linkKey, channelId: link.channelId, videoId: link.videoId, collectedAt: deps.now, title: parsed.title, videoState, observation: parsed.observation, rows, channel, windowsCollected, windowsNotDue, skipped, failures, requests: calls, outcome };
}
