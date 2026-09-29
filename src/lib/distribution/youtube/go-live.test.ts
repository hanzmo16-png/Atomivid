/**
 * YouTube go-live tests: doctor, read-only scopes, encryption/refresh, ingestion robustness
 * (duplicates, unavailable, partial, quota/rate-limit, token expiry, missing video), snapshots
 * 24h/48h/7d/28d, linkage, launch record behind the Final Cut gate, experiment model.
 * Global fetch throws; every "network" call is an injected fake.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { youtubeDoctor, REQUIRED_MIGRATIONS, type DoctorDeps } from "./doctor";
import { memoryYouTubeStore } from "./store";
import { encryptToken, GOOGLE_TOKEN_URL } from "./oauth";
import { monitorVideo, classifyFailure, READ_ONLY_ALLOWLIST } from "./monitor";
import { plannedSnapshots, applyRun, dueSnapshots, snapshotKey } from "./snapshots";
import { createLink } from "./link";
import { prepareLaunchRecord, recordManualPublication, LaunchGateError } from "./launch-record";
import { experimentRow } from "./experiment-model";
import { distributionFlags, assertCapability, CapabilityDisabledError, SCOPES, scopesFor } from "./capabilities";
import { METRIC_MAP, manualMetricRow } from "./analytics";
import { newEditorialRecord, editorialTransition, distributionEligible, IllegalEditorialTransitionError } from "@/lib/final-cut/gate";
import { containsSecretValue } from "@/lib/production-intelligence/capacity/accounts";

let globalCalls = 0;
globalThis.fetch = (async () => { globalCalls++; throw new Error("network forbidden in tests"); }) as typeof fetch;
const NOW = "2026-10-30T12:00:00.000Z";
const CH = "UCaaaaaaaaaaaaaaaaaaaaaa", VID = "dQw4w9WgXcQ", PUBLISHED = "2026-10-01T10:00:00Z";
const MASTER = { projectId: "prod-1", assetType: "MASTER", storagePath: "prod-1/final/master.mp4", checksumSha256: "a".repeat(64) };
const link = () => createLink({ projectId: "prod-1", requestId: null, masterChecksumSha256: MASTER.checksumSha256, masterStoragePath: MASTER.storagePath, channelId: CH, videoId: VID, publishedAt: PUBLISHED, linkedAt: NOW, linkedBy: "producer" }, [MASTER]);
const KEY = randomBytes(32).toString("base64");
const goodEnv = { GOOGLE_OAUTH_CLIENT_ID: "123-abc.apps.googleusercontent.com", GOOGLE_OAUTH_CLIENT_SECRET: "GOCSPX-test-secret-value", GOOGLE_OAUTH_REDIRECT_URI: "https://atomivid.test/api/distribution/youtube/callback", YOUTUBE_TOKEN_ENC_KEY: KEY };
const READ = scopesFor(["READ_CHANNEL", "READ_ANALYTICS"]);

type Resp = { ok: boolean; status: number; json(): Promise<unknown>; headers?: { get(n: string): string | null } };
const totalsReport = (views: number) => ({ columnHeaders: [{ name: "video" }, ...Object.values(METRIC_MAP).map((name) => ({ name }))], rows: [[VID, views, 40, 95, 3, 1, 0, 2, 0, 38.5]] });
function api(o: { videos?: Resp; totals?: (end: string) => Resp; retention?: Resp; traffic?: Resp; channel?: Resp; token?: Resp } = {}) {
  const okJ = (b: unknown): Resp => ({ ok: true, status: 200, json: async () => b });
  return async (url: string, init?: { body?: string; headers?: Record<string, string> }): Promise<Resp> => {
    const u = new URL(url);
    if (url === GOOGLE_TOKEN_URL) return o.token ?? okJ(new URLSearchParams(init?.body ?? "").get("grant_type") === "refresh_token" ? { access_token: "ya29.fresh" } : { refresh_token: "1//refresh-0123456789abcdef", scope: READ.join(" ") });
    if (u.pathname.endsWith("/videos")) return o.videos ?? okJ({ items: [{ id: VID, snippet: { title: "Ep", publishedAt: PUBLISHED, channelId: CH }, contentDetails: { duration: "PT10M" }, statistics: { viewCount: "500", likeCount: "20", commentCount: "3" }, status: { privacyStatus: "public" } }] });
    if (u.pathname.endsWith("/channels")) return o.channel ?? okJ({ items: [{ id: CH, snippet: { title: "T" }, statistics: { subscriberCount: "10", viewCount: "900", videoCount: "2" } }] });
    const dim = u.searchParams.get("dimensions");
    if (dim === "elapsedVideoTimeRatio") return o.retention ?? okJ({ columnHeaders: [{ name: "elapsedVideoTimeRatio" }, { name: "audienceWatchRatio" }], rows: [[0, 1], [0.05, 0.7], [0.5, 0.4]] });
    if (dim === "insightTrafficSourceType") return o.traffic ?? okJ({ columnHeaders: [{ name: "insightTrafficSourceType" }, { name: "views" }, { name: "estimatedMinutesWatched" }], rows: [["YT_SEARCH", 300, 20]] });
    if (dim === "video") return o.totals ? o.totals(u.searchParams.get("endDate")!) : okJ(totalsReport(u.searchParams.get("endDate") === "2026-10-08" ? 200 : 500));
    return okJ({ columnHeaders: [{ name: "estimatedMinutesWatched" }], rows: [[880]] });
  };
}
const err = (status: number, reason?: string, retryAfter?: string): Resp => ({ ok: false, status, json: async () => ({ error: { errors: reason ? [{ reason }] : [] } }), headers: { get: (n) => (n === "retry-after" ? retryAfter ?? null : null) } });

async function connectedStore() {
  const store = memoryYouTubeStore();
  await store.saveConnection("conn-1", encryptToken("1//refresh-secret-0123456789", KEY), READ);
  return store;
}

test("doctor: READY with full configuration; classifies config, database, auth and external blockers; prints no secret", async () => {
  const store = await connectedStore();
  const deps: DoctorDeps = { env: goodEnv, migrationFilesPresent: [...REQUIRED_MIGRATIONS], migrationsApplied: async () => [...REQUIRED_MIGRATIONS], fetch: api() as never, store, connectionId: "conn-1", now: NOW };
  const ready = await youtubeDoctor(deps);
  assert.equal(ready.status, "READY", ready.summary); assert.ok(ready.checks.every((c) => c.state !== "FAIL"));
  assert.ok(!containsSecretValue(ready) && !JSON.stringify(ready).includes(goodEnv.GOOGLE_OAUTH_CLIENT_SECRET) && !JSON.stringify(ready).includes(KEY), "no secret in the report");
  assert.equal((await youtubeDoctor({ ...deps, env: { ...goodEnv, GOOGLE_OAUTH_CLIENT_SECRET: undefined } })).status, "BLOCKED_CONFIG");
  assert.equal((await youtubeDoctor({ ...deps, env: { ...goodEnv, YOUTUBE_TOKEN_ENC_KEY: randomBytes(16).toString("base64") } })).status, "BLOCKED_CONFIG");
  assert.equal((await youtubeDoctor({ ...deps, env: { ...goodEnv, GOOGLE_OAUTH_REDIRECT_URI: "http://atomivid.test/other" } })).status, "BLOCKED_CONFIG");
  assert.equal((await youtubeDoctor({ ...deps, migrationsApplied: async () => ["0024_distribution_youtube.sql"] })).status, "BLOCKED_DATABASE");
  assert.equal((await youtubeDoctor({ ...deps, migrationsApplied: null })).status, "BLOCKED_DATABASE");
  assert.equal((await youtubeDoctor({ ...deps, connectionId: null })).status, "BLOCKED_AUTH");
  assert.equal((await youtubeDoctor({ ...deps, fetch: api({ token: err(400) }) as never })).status, "BLOCKED_AUTH", "refresh refused");
  assert.equal((await youtubeDoctor({ ...deps, fetch: (async () => { throw new Error("ENETUNREACH"); }) as never })).status, "BLOCKED_EXTERNAL");
  const wide = memoryYouTubeStore(); await wide.saveConnection("conn-1", encryptToken("x", KEY), [...READ, SCOPES.UPLOAD_PRIVATE[0]]);
  assert.equal((await youtubeDoctor({ ...deps, store: wide })).status, "BLOCKED_AUTH", "non-read scope");
  assert.equal((await youtubeDoctor({ ...deps, env: { ...goodEnv, YOUTUBE_UPLOAD_PRIVATE_ENABLED: "true" } })).status, "ERROR", "publish/upload capability on");
  assert.equal((await youtubeDoctor({ ...deps, env: { ...goodEnv, FINAL_CUT_ENABLED: "false" } })).status, "ERROR", "distribution gate off");
  assert.equal((await youtubeDoctor({ ...deps, migrationFilesPresent: [] })).status, "ERROR");
});

test("read-only scopes, AUTO_PUBLISH=false and zero publishing permissions", () => {
  assert.deepEqual(READ, ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"]);
  assert.ok(READ.every((s) => s.endsWith(".readonly")));
  const flags = distributionFlags({});
  assert.equal(flags.AUTO_PUBLISH, false); assert.deepEqual(flags.enabled, ["READ_CHANNEL", "READ_ANALYTICS"]);
  for (const c of ["PUBLISH", "SCHEDULE", "UPLOAD_PRIVATE"] as const) assert.throws(() => assertCapability(flags, c), CapabilityDisabledError);
  assert.ok(READ_ONLY_ALLOWLIST.every((u) => !u.includes("/upload/")));
});

test("token encryption at rest + refresh through the monitor when the API answers 401", async () => {
  const store = await connectedStore();
  assert.ok(store.connections.get("conn-1")!.refreshTokenEnc.startsWith("v1.") && !store.connections.get("conn-1")!.refreshTokenEnc.includes("refresh-secret"));
  let first = true, refreshes = 0;
  const f = api();
  const expiring = async (url: string, init?: { headers?: Record<string, string>; body?: string }) => { if (first && new URL(url).pathname.endsWith("/videos")) { first = false; return err(401); } return f(url, init); };
  const run = await monitorVideo(link(), { fetch: expiring as never, accessToken: "ya29.stale", now: NOW, refreshToken: async () => { refreshes++; return "ya29.fresh"; } });
  assert.equal(refreshes, 1); assert.equal(run.outcome, "COMPLETE"); assert.ok(run.rows.length > 5);
  const noRefresh = await monitorVideo(link(), { fetch: (async () => err(401)) as never, accessToken: "ya29.stale", now: NOW });
  assert.equal(noRefresh.outcome, "TOKEN_EXPIRED"); assert.equal(noRefresh.rows.length, 0);
});

test("ingestion: duplicate runs never duplicate rows or snapshots; snapshots 24h/48h/7d/28d are idempotent", async () => {
  const store = memoryYouTubeStore();
  const r1 = await monitorVideo(link(), { fetch: api() as never, accessToken: "t", now: NOW });
  await store.upsertRows(r1.rows); const n = store.rows.size;
  const r2 = await monitorVideo(link(), { fetch: api() as never, accessToken: "t", now: NOW });
  await store.upsertRows(r2.rows); assert.equal(store.rows.size, n, "same keys, no duplicates");
  const planned = plannedSnapshots(CH, VID, PUBLISHED, NOW);
  assert.deepEqual(planned.map((s) => [s.window, s.status]), [["24h", "PENDING"], ["48h", "PENDING"], ["7d", "PENDING"], ["28d", "PENDING"]]);
  const s1 = applyRun([], r1, PUBLISHED);
  assert.deepEqual(s1.map((s) => [s.window, s.status]), [["24h", "PENDING"], ["48h", "PENDING"], ["7d", "COLLECTED"], ["28d", "COLLECTED"]], "24h/48h need a Data API counter taken near the window end; the daily windows are collected");
  assert.equal(s1[2].metrics.views, 200); assert.equal(s1[3].metrics.views, 500); assert.equal(s1[2].source, "youtube-analytics-v2");
  const s2 = applyRun(s1, { ...r2, rows: r2.rows.map((r) => ({ ...r, value: r.value * 10 })) }, PUBLISHED);
  assert.deepEqual(s2[2], s1[2], "a COLLECTED snapshot is immutable");
  await store.upsertPerformanceSnapshots(s1); await store.upsertPerformanceSnapshots(s2.map((s) => ({ ...s, metrics: { views: 1 } })));
  assert.equal((await store.listPerformanceSnapshots(CH, VID)).find((s) => s.window === "7d")!.metrics.views, 200);
  assert.equal(snapshotKey(CH, VID, "7d"), s1[2].snapshotKey);
  // Too new: nothing due.
  const fresh = plannedSnapshots(CH, VID, "2026-10-30T11:00:00Z", NOW);
  assert.ok(fresh.every((s) => s.status === "NOT_DUE")); assert.equal(dueSnapshots(fresh, NOW).length, 0);
  const early = await monitorVideo({ ...link(), publishedAt: "2026-10-30T11:00:00Z" }, { fetch: api({ videos: { ok: true, status: 200, json: async () => ({ items: [{ id: VID, snippet: { title: "Ep", publishedAt: "2026-10-30T11:00:00Z", channelId: CH }, status: { privacyStatus: "unlisted" } }] }) } }) as never, accessToken: "t", now: NOW });
  assert.equal(early.videoState, "UNLISTED"); assert.deepEqual(early.windowsNotDue, ["7d", "28d"]);
});

test("ingestion: analytics unavailable / partial / quota / rate limit / missing video / API down are classified, never invented", async () => {
  const empty = { ok: true, status: 200, json: async () => ({ columnHeaders: [{ name: "video" }], rows: [] }) } as Resp;
  const notYet = await monitorVideo(link(), { fetch: api({ totals: () => empty, retention: empty, traffic: empty }) as never, accessToken: "t", now: NOW });
  assert.equal(notYet.outcome, "COMPLETE"); assert.deepEqual(notYet.windowsCollected, []); assert.ok(notYet.skipped.some((s) => s.includes("not available yet")));
  assert.ok(notYet.rows.every((r) => r.source === "youtube-data-v3"), "only the public counters exist");
  const partial = await monitorVideo(link(), { fetch: api({ retention: err(500) }) as never, accessToken: "t", now: NOW });
  assert.equal(partial.outcome, "PARTIAL"); assert.deepEqual(partial.failures.map((f) => [f.step, f.kind]), [["retention", "API_UNAVAILABLE"]]);
  assert.ok(partial.rows.some((r) => r.metric === "views") && !partial.rows.some((r) => r.metric === "audienceWatchRatio"));
  const quota = await monitorVideo(link(), { fetch: (async () => err(403, "quotaExceeded")) as never, accessToken: "t", now: NOW });
  assert.equal(quota.outcome, "QUOTA_EXCEEDED"); assert.equal(quota.failures[0].retryAfterSeconds, 86400);
  const rate = await monitorVideo(link(), { fetch: (async () => err(429, "rateLimitExceeded", "30")) as never, accessToken: "t", now: NOW });
  assert.equal(rate.outcome, "RATE_LIMITED"); assert.equal(rate.failures[0].retryAfterSeconds, 30);
  const missing = await monitorVideo(link(), { fetch: api({ videos: { ok: true, status: 200, json: async () => ({ items: [] }) } }) as never, accessToken: "t", now: NOW });
  assert.equal(missing.outcome, "VIDEO_MISSING"); assert.equal(missing.videoState, "MISSING"); assert.ok(missing.rows.every((r) => r.videoId !== VID || r.metric === "views" ? true : false));
  const snaps = applyRun([], missing, PUBLISHED);
  assert.ok(snaps.filter((s) => s.status === "UNAVAILABLE").length === 4);
  const down = await monitorVideo(link(), { fetch: (async () => err(503)) as never, accessToken: "t", now: NOW });
  assert.equal(down.outcome, "API_UNAVAILABLE");
  const pending = applyRun([], down, PUBLISHED);
  assert.ok(pending.filter((s) => s.window === "7d")[0].status === "PENDING" && pending[2].attempts === 1 && pending[2].lastFailure);
  const net = await monitorVideo(link(), { fetch: (async () => { throw new Error("ECONNRESET"); }) as never, accessToken: "t", now: NOW });
  assert.equal(net.outcome, "API_UNAVAILABLE"); assert.ok(net.failures.every((f) => f.kind === "NETWORK"));
  const priv = await monitorVideo(link(), { fetch: api({ videos: { ok: true, status: 200, json: async () => ({ items: [{ id: VID, snippet: { title: "Ep", publishedAt: PUBLISHED, channelId: CH }, status: { privacyStatus: "private" } }] }) } }) as never, accessToken: "t", now: NOW });
  assert.equal(priv.videoState, "PRIVATE"); assert.equal(priv.outcome, "COMPLETE", "the owner's analytics still work for a private video");
  assert.equal((await classifyFailure("x", err(404))).kind, "NOT_FOUND");
});

test("Final Cut -> Distribution gate: blocked without EDITORIAL_QA_PASS; a human override is explicit and audited", () => {
  const flags = { enabled: true };
  assert.equal(distributionEligible(null, flags).eligible, false);
  let rec = newEditorialRecord("prod-1", "master-1", "RENDERED");
  assert.equal(distributionEligible(rec, flags).eligible, false);
  rec = editorialTransition(rec, "EDITORIAL_INSPECTING", NOW);
  const failReport = { verdict: "HUMAN_REVIEW_REQUIRED", masterId: "master-1", reportId: "fcr_x", inputSha256: "f".repeat(64) } as never;
  rec = editorialTransition(rec, "HUMAN_REVIEW_REQUIRED", NOW, { report: failReport });
  assert.equal(distributionEligible(rec, flags).eligible, false);
  assert.throws(() => editorialTransition(rec, "EDITORIAL_QA_PASS", NOW), IllegalEditorialTransitionError, "no silent override");
  rec = editorialTransition(rec, "EDITORIAL_QA_PASS", NOW, { humanOverride: { by: "owner@atomivid.test", decision: "accept", reason: "intentional stylistic black" } });
  const ev = rec.history[rec.history.length - 1];
  assert.deepEqual({ by: ev.humanOverride?.by, reason: ev.humanOverride?.reason, at: ev.at, from: ev.from, to: ev.to }, { by: "owner@atomivid.test", reason: "intentional stylistic black", at: NOW, from: "HUMAN_REVIEW_REQUIRED", to: "EDITORIAL_QA_PASS" });
  assert.equal(distributionEligible(rec, flags).eligible, true);
  assert.equal(distributionEligible(null, { enabled: false }).eligible, true, "only an explicit FINAL_CUT_ENABLED=false bypasses");
});

test("launch record: prepared only behind the gate, never published; manual publication attaches the id and derives the link", () => {
  const base = { productionId: "prod-1", masterId: "master-1", masterHash: MASTER.checksumSha256, masterStoragePath: MASTER.storagePath, title: "Episode", description: "d", chapters: [{ startSeconds: 0, title: "Intro" }], language: "en", thumbnailReference: "prod-1/thumb.png", visibilityIntent: "unlisted" as const, channelId: CH, createdAt: NOW };
  assert.throws(() => prepareLaunchRecord(base, { editorial: null, flags: { enabled: true }, masters: [MASTER] }), LaunchGateError);
  let rec = newEditorialRecord("prod-1", "master-1", "RENDERED");
  rec = editorialTransition(rec, "EDITORIAL_INSPECTING", NOW);
  rec = editorialTransition(rec, "EDITORIAL_QA_PASS", NOW, { report: { verdict: "PASS", masterId: "master-1", reportId: "fcr_pass", inputSha256: "f".repeat(64) } as never });
  const lr = prepareLaunchRecord(base, { editorial: rec, flags: { enabled: true }, masters: [MASTER] });
  assert.equal(lr.status, "PREPARED"); assert.equal(lr.youtubeVideoId, null); assert.equal(lr.finalCutStatus, "EDITORIAL_QA_PASS"); assert.equal(lr.finalCutReportId, "fcr_pass");
  assert.throws(() => prepareLaunchRecord({ ...base, masterHash: "b".repeat(64) }, { editorial: rec, flags: { enabled: true }, masters: [MASTER] }), LaunchGateError);
  assert.throws(() => prepareLaunchRecord({ ...base, masterId: "master-2" }, { editorial: rec, flags: { enabled: true }, masters: [MASTER] }), /passed on master-1/);
  const pub = recordManualPublication(lr, { youtubeVideoId: VID, publishedAt: PUBLISHED, publishedBy: "owner" }, [MASTER]);
  assert.equal(pub.record.status, "PUBLISHED_MANUALLY"); assert.equal(pub.link.linkKey, `prod-1:${VID}`);
  assert.throws(() => recordManualPublication(pub.record, { youtubeVideoId: "AAAAAAAAAAA", publishedAt: PUBLISHED, publishedBy: "owner" }, [MASTER]), LaunchGateError);
});

test("experiment model: generic YouTube vs production row; unknown stays null; CTR only from a manual source", async () => {
  const run = await monitorVideo(link(), { fetch: api() as never, accessToken: "t", now: NOW });
  const snaps = applyRun([], run, PUBLISHED);
  const rows = [...run.rows, manualMetricRow(CH, VID, "impressionsCtr", 5.5, "2026-10-01", "2026-10-30", NOW)];
  const row = experimentRow(link(), "7d", snaps, rows, { productionId: "prod-1", costReport: { cogsUsd: 5.27, byProvider: { runway: { actualUsd: 1.75 } } }, finalCutMetrics: { opening: { shotCount: 13, averageShotSec: 2.31, movementDensity: 0.69, stillStreakMaxSec: 5 }, editorial: { averageShotSec: 4, motionDensity: 0.54 } }, finalCutIssueCount: 46, repairCount: 0 }, 600);
  assert.equal(row.youtube.views, 200); assert.equal(row.youtube.averagePercentageViewed, 38.5); assert.equal(row.youtube.retentionAt30s, 0.7); assert.deepEqual(row.youtube.trafficSources, { YT_SEARCH: 300 });
  assert.equal(row.youtube.impressionsCtr, 5.5); assert.equal(row.youtube.ctrSource, "manual_entry"); assert.equal(row.youtube.impressions, null);
  assert.deepEqual({ cost: row.production.productionCostUsd, density: row.production.openingShotDensity, streak: row.production.stillStreakSec, render: row.production.renderDurationSec }, { cost: 5.27, density: 13 / 30, streak: 5, render: null });
  const bare = experimentRow(link(), "28d", [], [], null, null);
  assert.ok(Object.values(bare.youtube).every((v) => v === null) && Object.values(bare.production).every((v) => v === null));
});

test("no real network call happened in this file", () => { assert.equal(globalCalls, 0); });
