/**
 * YouTube OAuth READ-ONLY (Production integration): exact scopes, no incremental authorization,
 * UPLOAD_PRIVATE contamination, granted-scope verification, state/PKCE/token-handling security and a
 * static import-graph gate for the two routes. Every fetch is a fake: no Google call, no real token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { buildAuthorizationUrl, decryptToken, exchangeCode, OAuthConfigError } from "./oauth";
import { distributionFlags, scopesFor } from "./capabilities";
import { startConnect, completeConnect } from "./connect-flow";
import { memoryYouTubeOAuthStore } from "./oauth-store";
import { channelQuery } from "./oauth-channel-query";

let realNetwork = 0;
globalThis.fetch = (async () => { realNetwork++; throw new Error("real network forbidden in tests"); }) as typeof fetch;

const READ_ONLY = ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"];
const FORBIDDEN = ["https://www.googleapis.com/auth/youtube ", "https://www.googleapis.com/auth/youtube\"", "youtube.upload", "youtube.force-ssl", "youtubepartner", "youtube.channel-memberships", "adsense"];
const KEY = randomBytes(32).toString("base64");
const OWNER = "33333333-3333-4333-8333-333333333333";
const baseEnv = { GOOGLE_OAUTH_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_OAUTH_REDIRECT_URI: "https://atomivid.vercel.app/api/distribution/youtube/callback", GOOGLE_OAUTH_CLIENT_SECRET: "test-secret", YOUTUBE_TOKEN_ENC_KEY: KEY };
const NOW = "2026-09-30T12:00:00.000Z";
const scopesOf = (url: string) => (new URL(url).searchParams.get("scope") ?? "").split(" ").filter(Boolean).sort();

test("startConnect requests EXACTLY youtube.readonly + yt-analytics.readonly, PKCE S256, offline, no include_granted_scopes", async () => {
  const store = memoryYouTubeOAuthStore();
  const r = await startConnect({ store, env: baseEnv, now: NOW }, OWNER);
  const u = new URL(r.url);
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual(scopesOf(r.url), [...READ_ONLY].sort());
  assert.equal(u.searchParams.get("include_granted_scopes"), null, "incremental authorization must stay ABSENT");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("redirect_uri"), baseEnv.GOOGLE_OAUTH_REDIRECT_URI);
  for (const f of FORBIDDEN) assert.ok(!r.url.includes(f), `forbidden scope present: ${f}`);
  const pending = store.pending.get(u.searchParams.get("state")!);
  assert.ok(pending && pending.ownerUserId === OWNER && pending.connectionId === r.connectionId, "state is server-side and bound to the owner");
  assert.ok(pending!.codeVerifier.length >= 43 && !r.url.includes(pending!.codeVerifier), "code_verifier never leaves the server");
  assert.ok(/^[A-Za-z0-9_-]{32}$/.test(u.searchParams.get("state")!), "state is 24 random bytes, base64url");
});

test("UPLOAD_PRIVATE contamination: YOUTUBE_UPLOAD_PRIVATE_ENABLED=true does NOT change the consent scopes", async () => {
  const env = { ...baseEnv, YOUTUBE_UPLOAD_PRIVATE_ENABLED: "true" };
  assert.ok(distributionFlags(env).enabled.includes("UPLOAD_PRIVATE"), "flag is honoured elsewhere");
  assert.equal(distributionFlags(env).AUTO_PUBLISH, false);
  const r = await startConnect({ store: memoryYouTubeOAuthStore(), env, now: NOW }, OWNER);
  assert.deepEqual(scopesOf(r.url), [...READ_ONLY].sort(), "consent scopes must be exactly the two read-only scopes");
  for (const f of FORBIDDEN) assert.ok(!r.url.includes(f), `forbidden scope present: ${f}`);
  assert.ok(!scopesFor(["READ_CHANNEL", "READ_ANALYTICS"]).some((s) => /upload|force-ssl|partner/.test(s)));
  const direct = buildAuthorizationUrl({ clientId: "c", redirectUri: "https://x/cb" }, distributionFlags(env).enabled.filter((c) => c === "READ_CHANNEL" || c === "READ_ANALYTICS"), "s");
  assert.deepEqual(scopesOf(direct.url), [...READ_ONLY].sort());
});

test("missing Google configuration fails safely (503-class OAuthConfigError naming variables, never values) and never reaches Google", async () => {
  const store = memoryYouTubeOAuthStore();
  await assert.rejects(startConnect({ store, env: { YOUTUBE_TOKEN_ENC_KEY: KEY }, now: NOW }, OWNER), (e: Error) => e instanceof OAuthConfigError && /GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_REDIRECT_URI/.test(e.message) && !e.message.includes(KEY));
  assert.equal(store.pending.size, 0, "nothing persisted without configuration");
  assert.equal(realNetwork, 0);
});

const fakeGoogle = (granted: string[], calls: string[]) => (async (url: string, init?: { body?: string }) => {
  calls.push(url);
  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    const grant = new URLSearchParams(init?.body ?? "").get("grant_type");
    return { ok: true, status: 200, json: async () => (grant === "authorization_code" ? { refresh_token: "1//fake-refresh", access_token: "ya29.fake", scope: granted.join(" ") } : { access_token: "ya29.fake-access" }) };
  }
  if (url.startsWith("https://www.googleapis.com/youtube/v3/channels")) return { ok: true, status: 200, json: async () => ({ items: [{ id: "UCaaaaaaaaaaaaaaaaaaaaaa", snippet: { title: "Fake Channel" } }] }) };
  throw new Error(`unexpected URL ${url}`);
}) as never;

test("completeConnect: exact read-only grant → encrypted envelope stored, channel identified via channels.list mine=true only; tokens never in the result", async () => {
  const store = memoryYouTubeOAuthStore(); const calls: string[] = [];
  const start = await startConnect({ store, env: baseEnv, now: NOW }, OWNER);
  const state = new URL(start.url).searchParams.get("state")!;
  const r = await completeConnect({ store, env: baseEnv, fetch: fakeGoogle(READ_ONLY, calls), now: NOW }, OWNER, "auth-code", state, { language: "es", niche: "history", timezone: "UTC" });
  assert.equal(r.channel.channelId, "UCaaaaaaaaaaaaaaaaaaaaaa"); assert.equal(r.channel.title, "Fake Channel"); assert.equal(r.channel.status, "connected");
  assert.deepEqual(r.scopes, [...READ_ONLY].sort());
  assert.ok(!JSON.stringify(r).includes("1//fake-refresh") && !JSON.stringify(r).includes("ya29"), "no token in the response");
  const stored = store.connections.get(start.connectionId)!;
  assert.ok(!stored.refreshTokenEnc.includes("1//fake-refresh") && stored.refreshTokenEnc.startsWith("v1."), "refresh token encrypted (AES-256-GCM envelope)");
  assert.equal(decryptToken(stored.refreshTokenEnc, KEY), "1//fake-refresh");
  assert.equal(calls.filter((u) => u.startsWith("https://www.googleapis.com/")).length, 1, "exactly one Data API call");
  assert.equal(calls.find((u) => u.startsWith("https://www.googleapis.com/")), channelQuery());
  assert.ok(channelQuery().includes("part=snippet") && channelQuery().includes("mine=true") && !/videos|playlist|thumbnails|comment|insert|update|delete/.test(channelQuery()));
  assert.equal(store.pending.size, 0, "state consumed (one-time)");
});

test("granted scopes are verified: any extra or write-capable scope is refused and YouTube is never called with that token", async () => {
  for (const extra of ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube", "https://www.googleapis.com/auth/youtube.force-ssl", "https://www.googleapis.com/auth/youtubepartner"]) {
    const store = memoryYouTubeOAuthStore(); const calls: string[] = [];
    const start = await startConnect({ store, env: baseEnv, now: NOW }, OWNER);
    const state = new URL(start.url).searchParams.get("state")!;
    await assert.rejects(completeConnect({ store, env: baseEnv, fetch: fakeGoogle([...READ_ONLY, extra], calls), now: NOW }, OWNER, "code", state, { language: "es", niche: "", timezone: "UTC" }), /granted more than read scopes/);
    assert.equal(calls.filter((u) => u.startsWith("https://www.googleapis.com/")).length, 0, `no Data API call after ${extra}`);
    assert.equal(store.connections.size, 0, "nothing stored"); assert.equal(store.channels.size, 0);
  }
  // a missing read scope is refused too
  const store = memoryYouTubeOAuthStore(); const calls: string[] = [];
  const start = await startConnect({ store, env: baseEnv, now: NOW }, OWNER);
  await assert.rejects(completeConnect({ store, env: baseEnv, fetch: fakeGoogle([READ_ONLY[0]], calls), now: NOW }, OWNER, "code", new URL(start.url).searchParams.get("state")!, { language: "es", niche: "", timezone: "UTC" }), /did not grant read scopes/);
});

test("state is one-time, bound to the owner and expires after 15 minutes", async () => {
  const store = memoryYouTubeOAuthStore(); const calls: string[] = [];
  const start = await startConnect({ store, env: baseEnv, now: NOW }, OWNER);
  const state = new URL(start.url).searchParams.get("state")!;
  await assert.rejects(completeConnect({ store, env: baseEnv, fetch: fakeGoogle(READ_ONLY, calls), now: NOW }, "44444444-4444-4444-8444-444444444444", "code", state, { language: "es", niche: "", timezone: "UTC" }), /unknown or foreign OAuth state/);
  assert.equal(store.pending.size, 0, "a foreign attempt burns the state");
  const again = await startConnect({ store, env: baseEnv, now: NOW }, OWNER);
  const state2 = new URL(again.url).searchParams.get("state")!;
  await assert.rejects(completeConnect({ store, env: baseEnv, fetch: fakeGoogle(READ_ONLY, calls), now: "2026-09-30T12:16:00.000Z" }, OWNER, "code", state2, { language: "es", niche: "", timezone: "UTC" }), /expired/);
  await assert.rejects(completeConnect({ store, env: baseEnv, fetch: fakeGoogle(READ_ONLY, calls), now: NOW }, OWNER, "code", state2, { language: "es", niche: "", timezone: "UTC" }), /unknown or foreign OAuth state/, "replay refused");
  assert.equal(calls.length, 0, "no token exchange for a rejected state");
  const out = await exchangeCode(fakeGoogle(READ_ONLY, calls), { clientId: "c", redirectUri: "r" }, baseEnv, "code", "verifier");
  assert.ok(!out.refreshTokenEnc.includes("1//fake-refresh"));
});

test("import graph of connect/callback is free of Production Intelligence, Final Cut, Production Core and every write module", () => {
  const forbidden = [/production-intelligence/, /final-cut/, /production-core/, /\/upload/, /go-live/, /launch-record/, /launch-package/, /snapshots/, /monitor/, /video-data/, /channel-snapshot/, /\/store"/, /analytics/, /link"/, /memory"/, /videos\.(insert|update|delete)/, /thumbnails/, /playlists/, /comments/];
  const seen = new Map<string, string>();
  const resolve = (spec: string, from: string) => {
    const base = spec.startsWith("@/") ? path.join("src", spec.slice(2)) : spec.startsWith(".") ? path.join(path.dirname(from), spec) : null;
    if (!base) return null;
    for (const ext of ["", ".ts", ".tsx"]) if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return base + ext;
    return null;
  };
  const walk = (f: string, by: string) => {
    if (seen.has(f)) return; seen.set(f, by);
    for (const m of fs.readFileSync(f, "utf8").matchAll(/from\s+"([^"]+)"/g)) { const r = resolve(m[1], f); if (r) walk(r, f); }
  };
  for (const route of ["src/app/api/distribution/youtube/connect/route.ts", "src/app/api/distribution/youtube/callback/route.ts"]) walk(route, "<route>");
  const files = [...seen.keys()];
  for (const f of files) for (const p of forbidden) assert.ok(!p.test(f), `${f} (via ${seen.get(f)}) matches forbidden ${p}`);
  const src = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  assert.ok(!/videos\.insert|videos\.update|videos\.delete|\/thumbnails|\/playlists|commentThreads|youtube\.upload|force-ssl|youtubepartner/.test(src.replace(/\/\/.*$/gm, "")), "no write API or write scope in the OAuth graph");
  assert.ok(files.includes("src/lib/distribution/youtube/oauth-channel-query.ts") && files.includes("src/lib/distribution/youtube/oauth-store.ts"));
  assert.ok(!src.includes("localStorage") && !/console\.log\([^)]*(token|secret|key)/i.test(src), "no client storage, no token logging");
  assert.equal(realNetwork, 0);
});
