/**
 * "Conectar YouTube (solo lectura)": owner-only CTA that asks the server to start the read-only
 * OAuth flow and follows Google's consent URL. No scopes, secrets or tokens in the browser.
 * No network: fetch is faked everywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandCenterView } from "./CommandCenterView";
import { ConnectYouTubeButton } from "./ConnectYouTubeButton";
import { startYouTubeConnect, isGoogleConsentUrl, safeMessage, CONNECT_ENDPOINT } from "./connect-youtube";
import { CommandCenterService } from "@/lib/command-center/service";
import { memorySource, type MemoryData } from "@/lib/command-center/sources";
import { buildViewModel } from "@/lib/command-center/view-model";
import { CommandCenterAccessError } from "@/lib/command-center/access";
import { RICH, PARTIAL, NOW } from "@/lib/command-center/fixtures";

let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error("network forbidden in tests"); }) as typeof fetch;
const env = { AVATAR_PREPARATION_OWNER_EMAIL: "owner@atomivid.test" };
const owner = { id: "u-owner", email: "owner@atomivid.test", email_confirmed_at: NOW };
const normal = { id: "u-1", email: "user@example.com", email_confirmed_at: NOW };
const CTA = "Conectar YouTube (solo lectura)";
const SAFETY = "Conexión de solo lectura para métricas y analytics. No permite subir, editar ni publicar videos.";
const GOOGLE = "https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&scope=x&state=s";

async function page(d: MemoryData, youtubeConfigured: boolean, user = owner) {
  const svc = new CommandCenterService({ source: memorySource(d), env, now: () => NOW });
  const overview = await svc.section(user, "overview", "7D");
  const vm = buildViewModel({ data: overview.data as Parameters<typeof buildViewModel>[0]["data"], window: "7D", generatedAt: overview.generatedAt, youtubeConfigured, pwaReady: true });
  return { vm, html: renderToStaticMarkup(<CommandCenterView vm={vm} />) };
}

test("CTA visible for the owner when YouTube is configured but NOT connected; safety text says read-only", async () => {
  const { vm, html } = await page(PARTIAL, true);
  assert.equal(vm.youtube.setup, "NOT_CONNECTED");
  assert.ok(html.includes(CTA) && html.includes(SAFETY) && html.includes('data-testid="connect-youtube-readonly"'));
  assert.ok(html.includes('data-youtube="NOT_CONNECTED"'));
});

test("no CTA when already connected (no accidental duplicate connection) nor when Google is not configured", async () => {
  const connected = await page(RICH, true);
  assert.equal(connected.vm.youtube.setup, "CONNECTED"); assert.ok(!connected.html.includes(CTA) && connected.html.includes("1,240"));
  const notConfigured = await page(PARTIAL, false);
  assert.equal(notConfigured.vm.youtube.setup, "NOT_CONFIGURED"); assert.ok(!notConfigured.html.includes(CTA) && notConfigured.html.includes("Google OAuth configuration required"));
});

test("non-owner never reaches the CTA: the page's service denies them (403) before anything renders", async () => {
  await assert.rejects(page(PARTIAL, true, normal), (e: CommandCenterAccessError) => e.status === 403);
});

test("button posts ONLY to /api/distribution/youtube/connect and follows the returned Google consent URL", async () => {
  const calls: { url: string; method: string; body?: unknown }[] = []; const nav: string[] = [];
  const r = await startYouTubeConnect({ fetchImpl: async (url, init) => { calls.push({ url, method: init.method }); return { ok: true, status: 200, json: async () => ({ url: GOOGLE, connectionId: "ytc_abc" }) }; }, navigate: (u) => nav.push(u) });
  assert.ok(r.ok && r.connectionId === "ytc_abc");
  assert.deepEqual(calls, [{ url: CONNECT_ENDPOINT, method: "POST" }]);
  assert.deepEqual(nav, [GOOGLE]);
  assert.equal(CONNECT_ENDPOINT, "/api/distribution/youtube/connect");
});

test("connect failure never navigates and shows a controlled message without secrets or traces", async () => {
  const nav: string[] = [];
  const fail = async (status: number, body: unknown) => startYouTubeConnect({ fetchImpl: async () => ({ ok: false, status, json: async () => body }), navigate: (u) => nav.push(u) });
  const cfg = await fail(503, { error: "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_REDIRECT_URI are required" });
  assert.ok(!cfg.ok && cfg.message.includes("HTTP 503") && cfg.message.includes("GOOGLE_OAUTH_CLIENT_ID"), "variable NAMES may be shown");
  const trace = await fail(500, { error: "Error: boom\n    at handler (/var/task/route.js:1:1) secret=abc" });
  assert.ok(!trace.ok && trace.message === "No se pudo iniciar la conexión (HTTP 500)." && !trace.message.includes("abc"));
  const unauth = await fail(401, { error: "unauthenticated" });
  assert.ok(!unauth.ok && unauth.message.includes("unauthenticated"));
  const thrown = await startYouTubeConnect({ fetchImpl: async () => { throw new Error("network down"); }, navigate: (u) => nav.push(u) });
  assert.ok(!thrown.ok);
  assert.deepEqual(nav, [], "no navigation on any failure");
  assert.equal(safeMessage(500, "not-json"), "No se pudo iniciar la conexión (HTTP 500).");
});

test("only Google's OAuth consent endpoint is followed; any other URL from the server is refused", async () => {
  const nav: string[] = [];
  for (const bad of ["https://evil.example/o/oauth2/v2/auth", "http://accounts.google.com/o/oauth2/v2/auth", "https://accounts.google.com/other", "javascript:alert(1)", 42, null]) {
    const r = await startYouTubeConnect({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ url: bad, connectionId: "ytc_x" }) }), navigate: (u) => nav.push(u) });
    assert.ok(!r.ok, String(bad)); assert.equal(isGoogleConsentUrl(bad), false);
  }
  assert.deepEqual(nav, []);
  assert.equal(isGoogleConsentUrl(GOOGLE), true);
});

test("frontend carries no scopes, secrets, tokens or write-capable operation; button markup is mobile-safe", () => {
  const src = ["connect-youtube.ts", "ConnectYouTubeButton.tsx"].map((f) => fs.readFileSync(`src/app/dashboard/command-center/${f}`, "utf8")).join("\n");
  assert.ok(!/googleapis\.com\/auth|scope=|client_secret|GOOGLE_OAUTH_CLIENT_SECRET|YOUTUBE_TOKEN_ENC_KEY|refresh_token|access_token|localStorage|sessionStorage/.test(src));
  assert.ok(!/upload|publish|videos\.insert|videos\.update|videos\.delete|thumbnails|playlists|comments|schedule/i.test(src.replace(/No permite subir, editar ni publicar videos\./, "").replace(/\/\*[\s\S]*?\*\//g, "")));
  const html = renderToStaticMarkup(<ConnectYouTubeButton />);
  assert.ok(html.includes('type="button"') && html.includes("w-full") && html.includes("min-w-0") && html.includes(SAFETY));
  assert.ok(!html.includes("<form") && !html.includes("href="), "no form submission, no prebuilt link");
  assert.equal(networkCalls, 0);
});
