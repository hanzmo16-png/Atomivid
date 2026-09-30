import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { distributionFlags, assertCapability, scopesFor, CapabilityDisabledError } from "./capabilities";
import { buildAuthorizationUrl, encryptToken, decryptToken, exchangeCode } from "./oauth";
import { parseTotals, parseRetention, upsertRows, totalsQuery, type MetricRow } from "./analytics";
import { DistributionMemory, ChannelIsolationError } from "./memory";
import { validateLaunchPackage, LaunchPackageError } from "./launch-package";
import { prepareUpload, UploadRefusedError } from "./upload";

const A = "UCaaaaaaaaaaaaaaaaaaaaaa", B = "UCbbbbbbbbbbbbbbbbbbbbbb";
const NOW = "2026-09-29T00:00:00.000Z";

test("16: Distribution Memory is isolated by channelId", () => {
  const m = new DistributionMemory();
  const rows = parseTotals(A, "vid1", "2026-09-01", "2026-09-28", { columnHeaders: [{ name: "video" }, { name: "views" }], rows: [["vid1", 120]] }, NOW);
  m.observeMetrics(A, rows);
  assert.equal(m.metrics(A).length, 1);
  assert.equal(m.metrics(B).length, 0, "channel B sees nothing from channel A");
  assert.throws(() => m.observeMetrics(B, rows), ChannelIsolationError);
  assert.throws(() => m.observeVideo(B, { channelId: A, videoId: "vid1", publishedAt: null, topic: null, titleStructure: null, thumbnailMetadata: null, durationSeconds: null, hookStructure: null }), ChannelIsolationError);
  assert.throws(() => m.metrics(""), ChannelIsolationError);
});

test("17: AUTO_PUBLISH stays false; schedule/public refused; upload private off by default", () => {
  const flags = distributionFlags({});
  assert.equal(flags.AUTO_PUBLISH, false);
  assert.deepEqual(flags.enabled, ["READ_CHANNEL", "READ_ANALYTICS"]);
  assert.equal(distributionFlags({ AUTO_PUBLISH: "true", YOUTUBE_AUTO_PUBLISH: "true" }).AUTO_PUBLISH, false, "no env can enable auto-publish");
  assert.throws(() => assertCapability(flags, "PUBLISH"), CapabilityDisabledError);
  assert.throws(() => assertCapability(flags, "UPLOAD_PRIVATE"), CapabilityDisabledError);
  const pkg = validateLaunchPackage(basePkg({ approval: { status: "approved", approvedBy: "owner", approvedAt: NOW } }));
  assert.throws(() => prepareUpload(flags, pkg, "videos/x.mp4", "public"), UploadRefusedError);
  assert.throws(() => prepareUpload(distributionFlags({ YOUTUBE_UPLOAD_PRIVATE_ENABLED: "true" }), pkg, "videos/x.mp4", "scheduled"), UploadRefusedError);
  const req = prepareUpload(distributionFlags({ YOUTUBE_UPLOAD_PRIVATE_ENABLED: "true" }), pkg, "videos/x.mp4", "private");
  assert.equal(req.status.privacyStatus, "private");
  assert.throws(() => prepareUpload(distributionFlags({ YOUTUBE_UPLOAD_PRIVATE_ENABLED: "true" }), validateLaunchPackage(basePkg()), "videos/x.mp4", "private"), /not approved/);
});

test("OAuth: minimal read scopes, PKCE, server-side encrypted refresh token", async () => {
  const caps = distributionFlags({}).enabled;
  assert.deepEqual(scopesFor(caps), ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"]);
  const { url, codeVerifier } = buildAuthorizationUrl({ clientId: "cid.apps.googleusercontent.com", redirectUri: "https://example.test/cb" }, caps, "state-1");
  const u = new URL(url);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.ok(!url.includes("upload") && !url.includes(codeVerifier));
  assert.equal(u.searchParams.get("include_granted_scopes"), null, "no incremental authorization: earlier write grants are never merged in");
  assert.deepEqual(u.searchParams.get("scope")!.split(" ").sort(), ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"]);
  for (const forbidden of ["/auth/youtube ", "/auth/youtube\"", "youtube.force-ssl", "youtubepartner", "youtube.upload"]) assert.ok(!url.includes(forbidden), forbidden);
  const key = randomBytes(32).toString("base64");
  const env = { GOOGLE_OAUTH_CLIENT_SECRET: "test-secret", YOUTUBE_TOKEN_ENC_KEY: key };
  const out = await exchangeCode(async () => ({ ok: true, status: 200, json: async () => ({ refresh_token: "1//test-refresh", access_token: "ya29.test", scope: caps.join(" ") }) }), { clientId: "c", redirectUri: "r" }, env, "code", codeVerifier);
  assert.ok(!out.refreshTokenEnc.includes("1//test-refresh"), "stored envelope is encrypted");
  assert.equal(decryptToken(out.refreshTokenEnc, key), "1//test-refresh");
  assert.throws(() => decryptToken(out.refreshTokenEnc.replace(/.$/, "A"), key));
  assert.throws(() => encryptToken("x", Buffer.alloc(8).toString("base64")), /32 bytes/);
});

test("Analytics ingestion maps only real API metrics and is idempotent", () => {
  assert.match(totalsQuery("vid1", "2026-09-01", "2026-09-28"), /estimatedMinutesWatched/);
  const report = { columnHeaders: [{ name: "video" }, { name: "views" }, { name: "estimatedMinutesWatched" }, { name: "madeUpMetric" }], rows: [["vid1", 100, 250, 9]] };
  const rows = parseTotals(A, "vid1", "2026-09-01", "2026-09-28", report, NOW);
  assert.deepEqual(rows.map((r) => r.metric).sort(), ["views", "watchTimeMinutes"]);
  const store = new Map<string, MetricRow>();
  assert.deepEqual(upsertRows(store, rows), { inserted: 2, updated: 0 });
  assert.deepEqual(upsertRows(store, parseTotals(A, "vid1", "2026-09-01", "2026-09-28", report, "2026-09-30T00:00:00Z")), { inserted: 0, updated: 2 });
  const ret = parseRetention(A, "vid1", "2026-09-01", "2026-09-28", { columnHeaders: [{ name: "elapsedVideoTimeRatio" }, { name: "audienceWatchRatio" }], rows: [[0.01, 1.0], [0.5, 0.42]] }, NOW);
  assert.equal(ret.length, 2); assert.equal(ret[1].dimensionValue, 0.5); assert.equal(ret[0].source, "youtube-analytics-v2");
});

function basePkg(o: Record<string, unknown> = {}) {
  return {
    projectId: "p", channelId: A, titleCandidates: [{ text: "What Came Home", rationale: "story hook" }], thumbnailCandidates: [], description: "A dramatized reconstruction.",
    chapters: [{ startSeconds: 0, title: "Intro" }, { startSeconds: 60, title: "Inside" }, { startSeconds: 300, title: "Nightmare Hall" }], keywords: ["dulce"], hashtags: ["#dulce"],
    playlistRecommendation: null, pinnedCommentDraft: null, endScreenRecommendation: null, shortTeaserSuggestions: [], approval: { status: "proposed", approvedBy: null, approvedAt: null }, ...o,
  };
}

test("Launch package proposes; never promises views, virality, CTR or monetization", () => {
  assert.equal(validateLaunchPackage(basePkg()).approval.status, "proposed");
  assert.throws(() => validateLaunchPackage(basePkg({ description: "This will go viral, guaranteed." })), LaunchPackageError);
  assert.throws(() => validateLaunchPackage(basePkg({ chapters: [{ startSeconds: 5, title: "a" }, { startSeconds: 60, title: "b" }, { startSeconds: 90, title: "c" }] })), LaunchPackageError);
});
