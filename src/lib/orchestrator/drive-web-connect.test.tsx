/**
 * B5 «Conectar Google Drive»: web OAuth (PKCE + sealed cookie), real Drive check before storing, encrypted storage,
 * GitHub OIDC for the orchestrator's short-lived tokens, and the owner panel. USD 0, no network: FakeDrive and fake
 * fetches everywhere; the OIDC tokens are signed with a throwaway RSA key generated here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { FakeDrive } from "./fake-drive";
import { DRIVE_SCOPE } from "./google-oauth";
import { checkDriveConnection } from "./drive-check";
import { oidcDriveTokenSource, oidcDriveTokenProvider } from "./channel";
import { completeDriveConnect, driveConnectionStatus, driveWebConfig, memoryDriveConnectionStore, mintDriveAccessToken, startDriveConnect, DriveConnectError, type DriveWebConfig } from "./drive-web-connect";
import { bearer, verifyGithubOidc, ALLOWED_WORKFLOWS, DRIVE_TOKEN_AUDIENCE, GITHUB_OIDC_ISSUER, type OidcPolicy } from "./github-oidc";
import { decryptToken } from "@/lib/distribution/youtube/oauth";
import { driveResultMessage, startDriveConnect as startFromBrowser, DRIVE_CONNECT_ENDPOINT } from "@/app/dashboard/command-center/connect-drive";
import { ConnectDrivePanel } from "@/app/dashboard/command-center/ConnectDrivePanel";

const KEY = randomBytes(32).toString("base64");
const REDIRECT = "https://atomivid.vercel.app/api/orchestrator/drive/callback";
const env = { DRIVE_OAUTH_CLIENT_ID: "web-client", DRIVE_OAUTH_CLIENT_SECRET: "web-secret", DRIVE_OAUTH_REDIRECT_URI: REDIRECT, DRIVE_TOKEN_ENC_KEY: KEY };
const target = { root: "ROOT", solicitudes: "SOL", entregas: "ENT" };
const REFRESH = "1//owner-refresh";

test("configuración: cliente web con retorno https exacto y clave de 32 bytes; los errores nombran la variable, nunca su valor", () => {
  const cfg = driveWebConfig(env);
  assert.equal(cfg.clientId, "web-client");
  // Falls back to the web client already configured for YouTube.
  assert.equal(driveWebConfig({ GOOGLE_OAUTH_CLIENT_ID: "yt", GOOGLE_OAUTH_CLIENT_SECRET: "yts", DRIVE_OAUTH_REDIRECT_URI: REDIRECT, YOUTUBE_TOKEN_ENC_KEY: KEY }).clientId, "yt");
  const bad = (over: Record<string, string | undefined>) => { try { driveWebConfig({ ...env, ...over }); return null; } catch (e) { return (e as DriveConnectError).message; } };
  assert.match(bad({ DRIVE_OAUTH_CLIENT_ID: undefined })!, /DRIVE_OAUTH_CLIENT_ID/);
  assert.match(bad({ DRIVE_OAUTH_REDIRECT_URI: undefined })!, /DRIVE_OAUTH_REDIRECT_URI/);
  assert.match(bad({ DRIVE_OAUTH_REDIRECT_URI: "http://atomivid.vercel.app/api/orchestrator/drive/callback" })!, /https/);
  assert.match(bad({ DRIVE_OAUTH_REDIRECT_URI: "https://atomivid.vercel.app/otra" })!, /callback/);
  assert.match(bad({ DRIVE_OAUTH_REDIRECT_URI: `${REDIRECT}?x=1` })!, /callback/);
  assert.equal(bad({ DRIVE_OAUTH_REDIRECT_URI: "http://localhost:3000/api/orchestrator/drive/callback" }), null, "local development");
  assert.match(bad({ DRIVE_TOKEN_ENC_KEY: Buffer.alloc(16).toString("base64") })!, /32 bytes/);
  assert.doesNotMatch(bad({ DRIVE_OAUTH_CLIENT_ID: undefined })!, /web-secret|web-client/);
});

/** Google: the authorization_code exchange (checks redirect, client, PKCE) on top of FakeDrive for everything else. */
function google(opts: { owned?: boolean; scope?: string; grantRefresh?: boolean } = {}) {
  const creds = { clientId: "web-client", clientSecret: "web-secret", refreshToken: REFRESH };
  const drive = new FakeDrive(creds, 2, opts.scope);
  drive.folders.set("ROOT", { parents: ["MYDRIVE"], ownedByMe: opts.owned ?? true, canAddChildren: true });
  drive.folders.set("SOL", { parents: ["ROOT"], ownedByMe: true, canAddChildren: true });
  drive.folders.set("ENT", { parents: ["ROOT"], ownedByMe: true, canAddChildren: true });
  drive.add("SOL", "T-1__para-claude__x.md", "x");
  const state = { challenge: "", exchanges: 0, revokes: 0 };
  const fetch = async (url: string, init: RequestInit = {}) => {
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) { state.revokes++; return new Response("{}"); }
    if (url === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(String(init.body));
      if (p.get("grant_type") === "authorization_code") {
        state.exchanges++;
        const pkceOk = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url") === state.challenge;
        if (p.get("code") !== "4/good-code" || p.get("redirect_uri") !== REDIRECT || p.get("client_id") !== "web-client" || p.get("client_secret") !== "web-secret" || !pkceOk) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        return new Response(JSON.stringify({ refresh_token: opts.grantRefresh === false ? undefined : REFRESH, scope: opts.scope ?? DRIVE_SCOPE }));
      }
    }
    return drive.fetch(url, init);
  };
  return { drive, fetch, state };
}

function begin(g: ReturnType<typeof google>, cfg: DriveWebConfig, now = new Date("2026-10-11T06:00:00Z")) {
  const s = startDriveConnect(cfg, now);
  const u = new URL(s.url);
  g.state.challenge = u.searchParams.get("code_challenge")!;
  return { ...s, u };
}

test("flujo completo: consentimiento → canje con PKCE → comprobación real de la carpeta → token cifrado guardado", async () => {
  const cfg = driveWebConfig(env), g = google(), store = memoryDriveConnectionStore();
  const s = begin(g, cfg);
  assert.equal(s.u.origin + s.u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(s.u.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(s.u.searchParams.get("scope"), DRIVE_SCOPE);
  assert.equal(s.u.searchParams.get("access_type"), "offline");
  assert.equal(s.u.searchParams.get("prompt"), "consent");
  assert.equal(s.u.searchParams.get("code_challenge_method"), "S256");
  assert.doesNotMatch(s.cookie, /verifier|state/, "the cookie is sealed, not readable");
  const q = new URLSearchParams({ code: "4/good-code", state: s.u.searchParams.get("state")! });
  const out = await completeDriveConnect({ cfg, store, fetch: g.fetch as never, now: new Date("2026-10-11T06:05:00Z"), target }, q, s.cookie);
  assert.deepEqual(out.checks, { tokenRefreshes: true, fullDriveScope: true, ownsCoordinationFolder: true, canWriteThere: true, subfoldersInside: true });
  assert.equal(out.counts?.solicitudes, 1);
  assert.ok(store.value);
  assert.doesNotMatch(JSON.stringify(store.value), new RegExp(REFRESH.replace(/\//g, "\\/")), "never stored in plaintext");
  assert.equal(decryptToken(store.value!.refreshTokenEnc, KEY), REFRESH);
  assert.deepEqual(await driveConnectionStatus(store), { connected: true, connectedAt: "2026-10-11T06:05:00.000Z" });
});

test("rechazos: estado distinto, cookie caducada, manipulada o de otro navegador, consentimiento cancelado, código inválido — nada se guarda", async () => {
  const cfg = driveWebConfig(env);
  const cases: [string, (s: ReturnType<typeof begin>) => { q: URLSearchParams; cookie: string | undefined; now?: Date }][] = [
    ["state", (s) => ({ q: new URLSearchParams({ code: "4/good-code", state: "f".repeat(32) }), cookie: s.cookie })],
    ["expired", (s) => ({ q: new URLSearchParams({ code: "4/good-code", state: s.u.searchParams.get("state")! }), cookie: s.cookie, now: new Date("2026-10-11T06:16:00Z") })],
    ["expired", (s) => ({ q: new URLSearchParams({ code: "4/good-code", state: s.u.searchParams.get("state")! }), cookie: s.cookie.slice(0, -4) + "AAAA" })],
    ["expired", (s) => ({ q: new URLSearchParams({ code: "4/good-code", state: s.u.searchParams.get("state")! }), cookie: undefined })],
    ["denied", (s) => ({ q: new URLSearchParams({ error: "access_denied", state: s.u.searchParams.get("state")! }), cookie: s.cookie })],
    ["code", (s) => ({ q: new URLSearchParams({ code: "x", state: s.u.searchParams.get("state")! }), cookie: s.cookie })],
    ["exchange", (s) => ({ q: new URLSearchParams({ code: "4/bad-code-xx", state: s.u.searchParams.get("state")! }), cookie: s.cookie })],
  ];
  for (const [code, mk] of cases) {
    const g = google(), store = memoryDriveConnectionStore(), s = begin(g, cfg), c = mk(s);
    await assert.rejects(completeDriveConnect({ cfg, store, fetch: g.fetch as never, now: c.now ?? new Date("2026-10-11T06:01:00Z"), target }, c.q, c.cookie), (e: unknown) => e instanceof DriveConnectError && e.code === code, code);
    assert.equal(store.value, null, `${code}: nothing stored`);
  }
  // A cookie sealed with another key (another deployment) is refused too.
  const g = google(), store = memoryDriveConnectionStore(), s = begin(g, { ...cfg, key: randomBytes(32).toString("base64") });
  await assert.rejects(completeDriveConnect({ cfg, store, fetch: g.fetch as never, now: new Date("2026-10-11T06:01:00Z"), target }, new URLSearchParams({ code: "4/good-code", state: s.u.searchParams.get("state")! }), s.cookie), /caducó/);
});

test("cuenta equivocada, sin Drive completo o sin token de renovación: no se guarda nada y no se revoca a ciegas", async () => {
  const cfg = driveWebConfig(env);
  for (const [opts, code] of [[{ owned: false }, "check"], [{ scope: "https://www.googleapis.com/auth/drive.file" }, "exchange"], [{ grantRefresh: false }, "exchange"]] as const) {
    const g = google(opts), store = memoryDriveConnectionStore(), s = begin(g, cfg);
    await assert.rejects(completeDriveConnect({ cfg, store, fetch: g.fetch as never, now: new Date("2026-10-11T06:01:00Z"), target }, new URLSearchParams({ code: "4/good-code", state: s.u.searchParams.get("state")! }), s.cookie), (e: unknown) => (e as DriveConnectError).code === code);
    assert.equal(store.value, null);
    assert.equal(g.state.revokes, 0);
  }
});

test("token corto para el orquestador: como mucho una hora; sin conexión o revocada, error claro y sin token", async () => {
  const cfg = driveWebConfig(env), g = google(), store = memoryDriveConnectionStore();
  await assert.rejects(mintDriveAccessToken({ cfg, store, fetch: g.fetch as never }), (e: unknown) => (e as DriveConnectError).code === "not-connected");
  const s = begin(g, cfg);
  await completeDriveConnect({ cfg, store, fetch: g.fetch as never, now: new Date("2026-10-11T06:01:00Z"), target }, new URLSearchParams({ code: "4/good-code", state: s.u.searchParams.get("state")! }), s.cookie);
  const t = await mintDriveAccessToken({ cfg, store, fetch: g.fetch as never });
  assert.match(t.access_token, /^ya29\.fake-/);
  assert.ok(t.expires_in <= 3600);
  assert.equal(t.scope, DRIVE_SCOPE);
  const revoked = google();
  revoked.drive.files = [];
  await assert.rejects(mintDriveAccessToken({ cfg: { ...cfg, clientSecret: "other" }, store, fetch: revoked.fetch as never }), (e: unknown) => (e as DriveConnectError).code === "refresh");
});

// --- GitHub OIDC -----------------------------------------------------------------------------------------------
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const jwks = async () => ({ keys: [jwk] });
const NOW = 1_791_700_000;
const REPO = "hanzmo16-png/Atomivid", BRANCH = "claude/atomivid-mvp-setup-0079jv";
const policy: OidcPolicy = { repository: REPO, defaultBranch: BRANCH, environment: "orchestrator", audience: DRIVE_TOKEN_AUDIENCE, workflows: ALLOWED_WORKFLOWS };
/**
 * Claims of a token requested by an ordinary job (steps, no reusable workflow) of orchestrator.yml, dispatched by hand on
 * the default branch in the «orchestrator» environment. Only claims GitHub documents for that case (OIDC reference,
 * "Custom claims provided by GitHub"): workflow_ref / workflow_sha, NO job_workflow_ref (that one is "for jobs using a
 * reusable workflow"). With an environment, sub is "repo:<owner>/<repo>:environment:<name>".
 */
const WF = (file: string, branch = BRANCH) => `${REPO}/.github/workflows/${file}@refs/heads/${branch}`;
const goodClaims: Record<string, unknown> = {
  jti: "6f4c1d2e-0000-4000-8000-000000000001", sub: `repo:${REPO}:environment:orchestrator`, aud: DRIVE_TOKEN_AUDIENCE, iss: GITHUB_OIDC_ISSUER,
  iat: NOW - 5, nbf: NOW - 5, exp: NOW + 300,
  ref: `refs/heads/${BRANCH}`, ref_type: "branch", ref_protected: "false", sha: "d11f531" + "0".repeat(33),
  repository: REPO, repository_id: "1000001", repository_owner: "hanzmo16-png", repository_owner_id: "2000002", repository_visibility: "public",
  run_id: "123", run_number: "7", run_attempt: "1", runner_environment: "github-hosted", actor: "hanzmo16-png", actor_id: "2000002",
  workflow: "Orchestrator (manual, gated)", workflow_ref: WF("orchestrator.yml"), workflow_sha: "d11f531" + "0".repeat(33),
  head_ref: "", base_ref: "", event_name: "workflow_dispatch", environment: "orchestrator", environment_node_id: "EN_kwDOtest",
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1", typ: "JWT" }, key = privateKey) {
  const head = `${b64(header)}.${b64(claims)}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(key).toString("base64url")}`;
}

test("OIDC: un job normal de orchestrator.yml o drive-oauth.yml (workflow_ref, sin job_workflow_ref) en la rama y el entorno autorizados", async () => {
  assert.equal("job_workflow_ref" in goodClaims, false, "the representative token has no job_workflow_ref");
  assert.deepEqual(await verifyGithubOidc(sign(goodClaims), policy, jwks, NOW), { ok: true, workflow: "orchestrator.yml", runId: "123" });
  assert.deepEqual(await verifyGithubOidc(sign({ ...goodClaims, workflow: "Drive OAuth (one-time owner authorization)", workflow_ref: WF("drive-oauth.yml") }), policy, jwks, NOW),
    { ok: true, workflow: "drive-oauth.yml", runId: "123" });
  // Should GitHub also send job_workflow_ref for a direct job, it can only be the same workflow: still accepted.
  assert.equal((await verifyGithubOidc(sign({ ...goodClaims, job_workflow_ref: WF("orchestrator.yml") }), policy, jwks, NOW)).ok, true);
  // The YAML really are ordinary jobs: steps, no `uses:` at job level (no reusable workflow) and id-token for OIDC.
  for (const w of ALLOWED_WORKFLOWS) {
    const y = readFileSync(`.github/workflows/${w}`, "utf8");
    assert.match(y, /id-token: write/);
    assert.match(y, /^ {4}environment: orchestrator$/m);
    assert.doesNotMatch(y, /^ {4}uses: /m, `${w}: no job calls a reusable workflow`);
    assert.match(y, /^ {4}steps:/m);
  }
});

test("OIDC: rechaza workflow ajeno, rama ajena, repositorio ajeno, entorno incorrecto, PR, caducado, reutilizable y firma inválida", async () => {
  const refuse: [Record<string, unknown>, RegExp][] = [
    // Another workflow of this repository, on the authorized branch (e.g. the Claude executor or any new file).
    [{ workflow_ref: WF("claude-executor.yml") }, /workflow no permitido/],
    [{ workflow_ref: WF("orchestrator-probe.yml") }, /workflow no permitido/],
    // An allowed file name, but from another branch: both the ref claim and workflow_ref name that branch.
    [{ ref: "refs/heads/claude/ops-env-check", workflow_ref: WF("orchestrator.yml", "claude/ops-env-check") }, /rama/],
    // Even if only workflow_ref pointed at another branch, it does not match the authorized one.
    [{ workflow_ref: WF("orchestrator.yml", "claude/otra") }, /workflow no permitido/],
    // A fork or another repository with the same workflow file.
    [{ repository: "otro/Atomivid", workflow_ref: `otro/Atomivid/.github/workflows/orchestrator.yml@refs/heads/${BRANCH}`, sub: "repo:otro/Atomivid:environment:orchestrator" }, /repositorio/],
    // No environment, or another one.
    [{ environment: undefined, sub: `repo:${REPO}:ref:refs/heads/${BRANCH}` }, /entorno/],
    [{ environment: "production" }, /entorno/],
    // Pull request events.
    [{ event_name: "pull_request", ref: "refs/pull/5/merge" }, /rama/],
    [{ event_name: "pull_request_target" }, /evento/],
    // Missing workflow_ref (no fallback to any other claim).
    [{ workflow_ref: undefined }, /workflow no permitido/],
    [{ workflow_ref: undefined, job_workflow_ref: WF("orchestrator.yml") }, /workflow no permitido/],
    // An allowed workflow whose job runs a reusable workflow (here or elsewhere): not one of the two files.
    [{ job_workflow_ref: "otra-org/automatizacion/.github/workflows/drive.yml@refs/heads/main" }, /reutilizable/],
    [{ job_workflow_ref: WF("claude-executor.yml") }, /reutilizable/],
    // Time, issuer and audience.
    [{ exp: NOW - 120 }, /caducado/],
    [{ nbf: NOW + 600, iat: NOW + 600 }, /aún no/],
    [{ iss: "https://evil.example" }, /emisor/],
    [{ aud: "sts.amazonaws.com" }, /audiencia/],
  ];
  for (const [over, re] of refuse) {
    const r = await verifyGithubOidc(sign({ ...goodClaims, ...over }), policy, jwks, NOW);
    assert.ok(!r.ok && re.test(r.reason), `${JSON.stringify(over)} → ${JSON.stringify(r)}`);
  }
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.match((await verifyGithubOidc(sign(goodClaims, undefined, other), policy, jwks, NOW) as { reason: string }).reason, /firma/);
  assert.match((await verifyGithubOidc(sign(goodClaims, { alg: "RS256", kid: "k2" }), policy, jwks, NOW) as { reason: string }).reason, /clave/);
  assert.match((await verifyGithubOidc(`${b64({ alg: "none", kid: "k1" })}.${b64(goodClaims)}.x`, policy, jwks, NOW) as { reason: string }).reason, /algoritmo/);
  assert.match((await verifyGithubOidc(sign(goodClaims, { alg: "HS256", kid: "k1" }), policy, jwks, NOW) as { reason: string }).reason, /algoritmo/);
  // A tampered payload keeps the old signature: refused.
  const [h, , sig] = sign(goodClaims).split(".");
  assert.match((await verifyGithubOidc(`${h}.${b64({ ...goodClaims, ref: "refs/heads/x" })}.${sig}`, policy, jwks, NOW) as { reason: string }).reason, /firma/);
  assert.match((await verifyGithubOidc("a.b", policy, jwks, NOW) as { reason: string }).reason, /mal formado/);
  assert.equal(bearer("Bearer " + sign(goodClaims))?.split(".").length, 3);
  assert.equal(bearer("Basic abc"), null);
});

test("GitHub Actions: pide el token OIDC con la audiencia correcta y usa el acceso corto contra Drive (sin secretos de Google)", async () => {
  const creds = { clientId: "web-client", clientSecret: "web-secret", refreshToken: REFRESH };
  const drive = new FakeDrive(creds);
  drive.folders.set("ROOT", { parents: ["MYDRIVE"], ownedByMe: true, canAddChildren: true });
  drive.folders.set("SOL", { parents: ["ROOT"], ownedByMe: true, canAddChildren: true });
  drive.folders.set("ENT", { parents: ["ROOT"], ownedByMe: true, canAddChildren: true });
  const seen: string[] = [];
  let endpointCalls = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    if (url.startsWith("https://actions.example/token")) {
      seen.push(new URL(url).searchParams.get("audience")!, new Headers(init.headers).get("authorization")!);
      return new Response(JSON.stringify({ value: "header.payload.signature" }));
    }
    if (url === "https://atomivid.vercel.app/api/orchestrator/drive/token") {
      endpointCalls++;
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer header.payload.signature");
      const t = await (await drive.fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH, client_id: "web-client", client_secret: "web-secret" }).toString() })).json();
      return new Response(JSON.stringify({ access_token: t.access_token, expires_in: 3599, scope: DRIVE_SCOPE }));
    }
    return drive.fetch(url, init);
  }) as typeof fetch;
  const actionsEnv = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-token" };
  const r = await checkDriveConnection(oidcDriveTokenSource("https://atomivid.vercel.app/api/orchestrator/drive/token", actionsEnv, fetchImpl), target, fetchImpl);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(seen, ["atomivid-drive-token", "bearer req-token"]);
  // The provider caches the access token until shortly before it expires.
  const provider = oidcDriveTokenProvider("https://atomivid.vercel.app/api/orchestrator/drive/token", actionsEnv, fetchImpl);
  const before = endpointCalls;
  await provider(); await provider();
  assert.equal(endpointCalls - before, 1);
  await assert.rejects(oidcDriveTokenSource("https://x", {}, fetchImpl)(), /id-token: write/);
});

// --- Owner panel and routes ------------------------------------------------------------------------------------
test("panel del propietario: botón «Conectar Google Drive», estado sin token, mensajes cerrados y solo la URL de Google", async () => {
  const html = renderToStaticMarkup(<ConnectDrivePanel configured connected={false} connectedAt={null} />);
  assert.match(html, /Conectar Google Drive/);
  assert.match(html, /data-drive-connect="NOT_CONNECTED"/);
  const connected = renderToStaticMarkup(<ConnectDrivePanel configured connected connectedAt="2026-10-11T06:05:00.000Z" result="conectado" />);
  assert.match(connected, /Volver a conectar Google Drive/);
  assert.match(connected, /2026-10-11 06:05 UTC/);
  assert.doesNotMatch(renderToStaticMarkup(<ConnectDrivePanel configured={false} connected={false} connectedAt={null} />), /<button/);
  assert.equal(driveResultMessage("<script>alert(1)</script>")?.text, "No se pudo completar la conexión. No se guardó nada.");
  assert.equal(driveResultMessage(undefined), null);
  let went = "";
  const ok = await startFromBrowser({ fetchImpl: async (url) => { assert.equal(url, DRIVE_CONNECT_ENDPOINT); return { ok: true, status: 200, json: async () => ({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" }) }; }, navigate: (u) => { went = u; } });
  assert.deepEqual(ok, { ok: true });
  assert.match(went, /^https:\/\/accounts\.google\.com\//);
  const evil = await startFromBrowser({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ url: "https://evil.example/o/oauth2/v2/auth" }) }), navigate: () => { throw new Error("must not navigate"); } });
  assert.equal(evil.ok, false);
  const src = ["connect-drive.ts", "ConnectDrivePanel.tsx"].map((f) => readFileSync(`src/app/dashboard/command-center/${f}`, "utf8")).join("\n");
  assert.doesNotMatch(src, /localStorage|sessionStorage|document\.cookie|refresh_token|client_secret/);
});

test("rutas: propietario para conectar, cookie httpOnly limitada al flujo, retorno sin datos, y el token solo tras verificar OIDC", () => {
  const connect = readFileSync("src/app/api/orchestrator/drive/connect/route.ts", "utf8");
  assert.match(connect, /if \(!isCommandCenterAdmin\(user\)\) return NextResponse\.json\(\{ error: "solo el propietario" \}, \{ status: 403/);
  assert.match(connect, /httpOnly: true, secure: process\.env\.NODE_ENV === "production", sameSite: "lax", path: "\/api\/orchestrator\/drive", maxAge: PENDING_TTL_MS \/ 1000/);
  assert.match(connect, /export async function POST\(\)/, "start is a POST (no cross-site GET starts an attempt)");
  const callback = readFileSync("src/app/api/orchestrator/drive/callback/route.ts", "utf8");
  assert.match(callback, /if \(!user \|\| !isCommandCenterAdmin\(user\)\) return back\("sin-permiso"\)/);
  assert.match(callback, /back\(e instanceof DriveConnectError \? e\.code : "error"\)/, "only the short code goes back, never Google's message");
  assert.match(callback, /maxAge: 0/, "the attempt cookie is cleared whatever happens");
  const token = readFileSync("src/app/api/orchestrator/drive/token/route.ts", "utf8");
  assert.ok(token.indexOf("verifyGithubOidc(") < token.indexOf("mintDriveAccessToken("), "OIDC is verified before any token is minted");
  assert.match(token, /if \(!v\.ok\) return NextResponse\.json\(\{ error: v\.reason \}, \{ status: 403/);
  for (const f of [connect, callback, token]) assert.match(f, /no-store/);
  assert.doesNotMatch(token + callback + connect, /console\.(log|info|error)/, "nothing is logged");
  for (const w of ["orchestrator.yml", "drive-oauth.yml"]) assert.match(readFileSync(`.github/workflows/${w}`, "utf8"), /id-token: write[\s\S]*ORCH_DRIVE_TOKEN_URL: https:\/\/atomivid\.vercel\.app\/api\/orchestrator\/drive\/token/);
});
