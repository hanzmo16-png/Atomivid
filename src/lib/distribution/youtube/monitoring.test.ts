/**
 * YouTube READ-ONLY monitoring tests with fixtures only. The global fetch throws; every
 * "network" call goes through an injected fake that records URLs and methods.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { parseTrafficSources, manualMetricRow, parseTotals, upsertRows, METRIC_MAP, type MetricRow } from "./analytics";
import { parseVideoList, iso8601DurationSeconds, videoQuery } from "./video-data";
import { parseChannel, parseUploads } from "./channel-snapshot";
import { windowsFor, compareWindows } from "./time-series";
import { createLink, upsertLink, LinkError } from "./link";
import { monitorVideo, readOnlyFetch, ReadOnlyViolationError, READ_ONLY_ALLOWLIST } from "./monitor";
import { memoryYouTubeStore } from "./store";
import { startConnect, completeConnect, tokenForConnection } from "./connect-flow";
import { encryptToken, GOOGLE_TOKEN_URL, OAuthConfigError } from "./oauth";
import { distributionFlags, assertCapability, CapabilityDisabledError } from "./capabilities";
import { containsSecretValue } from "@/lib/production-intelligence/capacity/accounts";

let globalCalls = 0;
globalThis.fetch = (async () => { globalCalls++; throw new Error("network forbidden in tests"); }) as typeof fetch;
const NOW = "2026-10-30T12:00:00.000Z";
const CH = "UCaaaaaaaaaaaaaaaaaaaaaa";
const VID = "dQw4w9WgXcQ";
const PUBLISHED = "2026-10-01T10:00:00Z";
const MASTER = { projectId: "iron-annals-001", assetType: "MASTER", storagePath: "iron-annals-001/final/master.mp4", checksumSha256: "a".repeat(64) };
const link = () => createLink({ projectId: "iron-annals-001", requestId: "req-1", masterChecksumSha256: MASTER.checksumSha256, masterStoragePath: MASTER.storagePath, channelId: CH, videoId: VID, publishedAt: PUBLISHED, linkedAt: NOW, linkedBy: "producer" }, [MASTER]);

type Call = { url: string; method: string; headers: Record<string, string> };
function fakeApi(calls: Call[], overrides: Partial<Record<string, unknown>> = {}) {
  const totals = (views: number) => ({ columnHeaders: [{ name: "video" }, ...Object.values(METRIC_MAP).map((name) => ({ name }))], rows: [[VID, views, 40, 95, 3, 1, 0, 2, 0, 38.5]] });
  return async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {} });
    const u = new URL(url);
    let body: unknown;
    if (u.pathname.endsWith("/videos")) body = overrides.videos ?? { items: [{ id: VID, snippet: { title: "Episode 1", publishedAt: PUBLISHED, channelId: CH }, contentDetails: { duration: "PT12M34S" }, statistics: { viewCount: "1234", likeCount: "56", commentCount: "7" } }] };
    else if (u.pathname.endsWith("/channels")) body = { items: [{ id: CH, statistics: { subscriberCount: "120", viewCount: "5400", videoCount: "3" }, contentDetails: { relatedPlaylists: { uploads: "UUaaaaaaaaaaaaaaaaaaaaaa" } } }] };
    else if (u.pathname.endsWith("/reports") && u.searchParams.get("dimensions") === "elapsedVideoTimeRatio") body = { columnHeaders: [{ name: "elapsedVideoTimeRatio" }, { name: "audienceWatchRatio" }], rows: [[0, 1], [0.5, 0.44], [1, 0.2]] };
    else if (u.pathname.endsWith("/reports") && u.searchParams.get("dimensions") === "insightTrafficSourceType") body = { columnHeaders: [{ name: "insightTrafficSourceType" }, { name: "views" }, { name: "estimatedMinutesWatched" }], rows: [["YT_SEARCH", 700, 20], ["SUBSCRIBER", 300, 12]] };
    else if (u.pathname.endsWith("/reports") && u.searchParams.get("dimensions") === "video") body = totals(u.searchParams.get("endDate") === "2026-10-08" ? 900 : 1200);
    else if (u.pathname.endsWith("/reports")) body = { columnHeaders: [{ name: "estimatedMinutesWatched" }, { name: "views" }], rows: [[880, 5000]] };
    else return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
}

test("YouTube: analytics fixtures map only real API metrics; traffic sources and manual Studio-only figures keep their source", () => {
  const rows = parseTrafficSources(CH, VID, "2026-10-01", "2026-10-30", { columnHeaders: [{ name: "insightTrafficSourceType" }, { name: "views" }, { name: "estimatedMinutesWatched" }], rows: [["YT_SEARCH", 700, 20]] }, NOW);
  assert.deepEqual(rows.map((r) => [r.metric, r.dimensionLabel, r.value]), [["views", "YT_SEARCH", 700], ["watchTimeMinutes", "YT_SEARCH", 20]]);
  const store = new Map<string, MetricRow>();
  assert.deepEqual(upsertRows(store, rows), { inserted: 2, updated: 0 }); assert.deepEqual(upsertRows(store, rows), { inserted: 0, updated: 2 });
  const m = manualMetricRow(CH, VID, "impressionsCtr", 4.2, "2026-10-01", "2026-10-30", NOW);
  assert.equal(m.source, "manual_entry");
  assert.throws(() => manualMetricRow(CH, VID, "impressions", -1, "2026-10-01", "2026-10-30", NOW));
  assert.ok(!("impressions" in METRIC_MAP), "impressions are never requested from the API (Studio-only)");
  const t = parseTotals(CH, VID, "2026-10-01", "2026-10-30", { columnHeaders: [{ name: "video" }, { name: "averageViewPercentage" }, { name: "madeUpMetric" }], rows: [[VID, 38.5, 1]] }, NOW);
  assert.deepEqual(t.map((r) => r.metric), ["averagePercentageViewed"]);
});

test("YouTube: Data API video/channel parsing and ISO durations; foreign channel refused", () => {
  const v = parseVideoList(CH, VID, { items: [{ id: VID, snippet: { title: "Ep", publishedAt: PUBLISHED, channelId: CH }, contentDetails: { duration: "PT1H2M3S" }, statistics: { viewCount: "10" } }] }, NOW);
  assert.equal(v.observation!.durationSeconds, 3723); assert.equal(v.rows.length, 1); assert.equal(v.rows[0].source, "youtube-data-v3"); assert.equal(v.title, "Ep");
  assert.equal(iso8601DurationSeconds("bogus"), null);
  assert.throws(() => parseVideoList(CH, VID, { items: [{ id: VID, snippet: { channelId: "UCbbbbbbbbbbbbbbbbbbbbbb" } }] }, NOW), /belongs to channel/);
  const c = parseChannel(CH, { items: [{ id: CH, statistics: { subscriberCount: "9", viewCount: "10", videoCount: "1" } }] }, NOW, { report: { columnHeaders: [{ name: "estimatedMinutesWatched" }], rows: [[42]] }, start: "2026-10-02", end: "2026-10-30" });
  assert.equal(c.subscribers, 9); assert.equal(c.watchTimeMinutes, 42);
  assert.equal(parseChannel(CH, { items: [{ id: CH, statistics: { subscriberCount: "9", hiddenSubscriberCount: true } }] }, NOW).subscribers, null, "hidden counts stay null, never guessed");
  assert.deepEqual(parseUploads(CH, { items: [{ snippet: { title: "A" }, contentDetails: { videoId: VID, videoPublishedAt: PUBLISHED } }, { snippet: {} }] }), [{ channelId: CH, videoId: VID, title: "A", publishedAt: PUBLISHED }]);
});

test("YouTube: time windows 24h/48h/7d/28d only when elapsed; nothing interpolated", () => {
  const w = windowsFor(PUBLISHED, "2026-10-05T00:00:00Z");
  assert.deepEqual(w.map((x) => [x.name, x.elapsed, x.granularity]), [["24h", true, "snapshot"], ["48h", true, "snapshot"], ["7d", false, "daily"], ["28d", false, "daily"]]);
  const snap = (collectedAt: string, value: number): MetricRow => ({ rowKey: "k" + collectedAt, channelId: CH, videoId: VID, metric: "views", value, dimensionValue: null, dimensionLabel: null, windowStart: "2026-10-01", windowEnd: collectedAt.slice(0, 10), source: "youtube-data-v3", collectedAt });
  const daily: MetricRow = { rowKey: "d7", channelId: CH, videoId: VID, metric: "views", value: 900, dimensionValue: null, dimensionLabel: null, windowStart: "2026-10-01", windowEnd: "2026-10-08", source: "youtube-analytics-v2", collectedAt: NOW };
  const cmp = compareWindows([snap("2026-10-02T09:30:00Z", 300), snap("2026-10-03T20:00:00Z", 500), daily], "views", PUBLISHED, NOW);
  assert.deepEqual(cmp.windows, { "24h": 300, "48h": null, "7d": 900, "28d": null });
});

test("YouTube: production <-> master <-> video link is validated and idempotent", () => {
  const l = link();
  assert.equal(l.linkKey, `iron-annals-001:${VID}`); assert.equal(l.status, "linked");
  assert.throws(() => createLink({ ...l, masterChecksumSha256: "b".repeat(64) }, [MASTER]), LinkError);
  assert.throws(() => createLink({ ...l, videoId: "short" }, [MASTER]));
  assert.throws(() => createLink({ ...l, masterStoragePath: "https://x/m.mp4?token=abc" }, [{ ...MASTER, storagePath: "https://x/m.mp4?token=abc" }]), /signed URL/);
  const store = new Map();
  assert.equal(upsertLink(store, l), "inserted"); assert.equal(upsertLink(store, l), "unchanged"); assert.equal(upsertLink(store, { ...l, publishedAt: "2026-10-01T11:00:00Z" }), "updated");
  assert.throws(() => upsertLink(store, { ...l, masterChecksumSha256: "c".repeat(64) }), LinkError);
});

test("YouTube: read-only monitor collects video, windows, retention, traffic and channel with GETs to allowlisted endpoints only", async () => {
  const calls: Call[] = [];
  const run = await monitorVideo(link(), { fetch: fakeApi(calls), accessToken: "ya29.test-token-value", now: NOW });
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.ok(calls.every((c) => READ_ONLY_ALLOWLIST.some((b) => c.url.startsWith(b))));
  assert.ok(calls.every((c) => c.headers.Authorization === "Bearer ya29.test-token-value"));
  assert.deepEqual(run.windowsCollected, ["7d", "28d"]);
  assert.equal(run.title, "Episode 1"); assert.equal(run.observation!.durationSeconds, 754);
  const metrics = new Set(run.rows.map((r) => r.metric));
  for (const m of ["views", "likes", "comments", "watchTimeMinutes", "averageViewDurationSeconds", "averagePercentageViewed", "subscribersGained", "audienceWatchRatio"]) assert.ok(metrics.has(m as MetricRow["metric"]), m);
  assert.ok(run.rows.some((r) => r.dimensionLabel === "YT_SEARCH"));
  assert.equal(run.channel!.subscribers, 120); assert.equal(run.channel!.watchTimeMinutes, 880);
  assert.equal(run.requests.length, calls.length);
  // Idempotent persistence: a second run writes the same keys.
  const st = memoryYouTubeStore();
  await st.upsertRows(run.rows); const n = st.rows.size;
  const run2 = await monitorVideo(link(), { fetch: fakeApi([]), accessToken: "t", now: NOW });
  await st.upsertRows(run2.rows); assert.equal(st.rows.size, n);
  await st.saveChannelSnapshot(run.channel!); await st.saveChannelSnapshot(run2.channel!); assert.equal(st.snapshots.length, 1);
  assert.ok(!containsSecretValue(JSON.stringify({ run: { ...run, requests: run.requests } })), "no token in the persisted run");
  // The wrapper refuses writes and unknown hosts before any network.
  const get = readOnlyFetch(fakeApi([]), "t");
  await assert.rejects(get(videoQuery(VID), { method: "POST" }), ReadOnlyViolationError);
  await assert.rejects(get("https://www.googleapis.com/upload/youtube/v3/videos?part=snippet"), ReadOnlyViolationError);
  await assert.rejects(get("https://www.googleapis.com/youtube/v3/videos/delete?id=x"), ReadOnlyViolationError);
});

test("YouTube: connect flow requests READ scopes only, stores an encrypted envelope, exposes no token; publish stays off", async () => {
  const env = { GOOGLE_OAUTH_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_OAUTH_REDIRECT_URI: "https://atomivid.test/api/distribution/youtube/callback", GOOGLE_OAUTH_CLIENT_SECRET: "test-secret", YOUTUBE_TOKEN_ENC_KEY: randomBytes(32).toString("base64") };
  const store = memoryYouTubeStore();
  const owner = "33333333-3333-4333-8333-333333333333";
  const { url, connectionId } = await startConnect({ store, env, now: NOW }, owner);
  const u = new URL(url);
  assert.equal(u.searchParams.get("scope"), "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256"); assert.ok(!url.includes("upload"));
  const state = u.searchParams.get("state")!;
  const calls: Call[] = [];
  const api = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {} });
    if (url === GOOGLE_TOKEN_URL) {
      const grant = new URLSearchParams(init?.body ?? "").get("grant_type");
      return { ok: true, status: 200, json: async () => (grant === "authorization_code" ? { refresh_token: "1//refresh-plain-0123456789abcdef", scope: "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly" } : { access_token: "ya29.short" }) };
    }
    return { ok: true, status: 200, json: async () => ({ items: [{ id: CH, snippet: { title: "The Iron Annals" } }] }) };
  };
  const r = await completeConnect({ store, env, fetch: api as never, now: NOW }, owner, "code-1", state, { language: "en", niche: "history", timezone: "Europe/Madrid" });
  assert.equal(r.channel.channelId, CH); assert.equal(r.channel.status, "connected"); assert.equal(r.channel.connectionId, connectionId);
  const stored = store.connections.get(connectionId)!;
  assert.ok(stored.refreshTokenEnc.startsWith("v1.") && !stored.refreshTokenEnc.includes("refresh-plain"), "refresh token encrypted at rest");
  assert.ok(!containsSecretValue(r), "response carries no token");
  await assert.rejects(completeConnect({ store, env, fetch: api as never, now: NOW }, owner, "code-2", state, { language: "en", niche: "", timezone: "UTC" }), OAuthConfigError, "state consumed once");
  // More than read scopes granted -> refused in read-only V1.
  const { url: url2 } = await startConnect({ store, env, now: NOW }, owner);
  const wide = async (url: string, init?: { method?: string; body?: string }) => (url === GOOGLE_TOKEN_URL && new URLSearchParams(init?.body ?? "").get("grant_type") === "authorization_code" ? { ok: true, status: 200, json: async () => ({ refresh_token: "1//x0123456789abcdefghij", scope: "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.upload" }) } : api(url, init));
  await assert.rejects(completeConnect({ store, env, fetch: wide as never, now: NOW }, owner, "c", new URL(url2).searchParams.get("state")!, { language: "en", niche: "", timezone: "UTC" }), /more than read scopes/);
  assert.equal(await tokenForConnection({ store, env, fetch: api as never }, connectionId), "ya29.short");
  assert.equal(encryptToken("x", env.YOUTUBE_TOKEN_ENC_KEY).startsWith("v1."), true);
  const flags = distributionFlags({});
  assert.throws(() => assertCapability(flags, "PUBLISH"), CapabilityDisabledError); assert.throws(() => assertCapability(flags, "UPLOAD_PRIVATE"), CapabilityDisabledError);
  assert.equal(flags.AUTO_PUBLISH, false);
});

test("no real network call happened in this file", () => { assert.equal(globalCalls, 0); });
