import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig, SMOKE_APPROVAL } from "./config";
import { checkTokenResponse, consentUrl, DRIVE_SCOPE, LOOPBACK_REDIRECT, parseRedirect, pkceChallenge, pkceVerifier, tokenRequestBody } from "./google-oauth";
import { identityFromHeaders, smokeAlreadyDone, smokeCallSent, smokePreflight, SMOKE_RUN_TITLE } from "./smoke";
import { buildRequest } from "./openai-auditor";

const NONCE = "0123456789abcdef0123456789abcdef";

test("OAuth desde Actions: enlace con PKCE ligado al secreto del cliente; nada secreto en el enlace", () => {
  const url = new URL(consentUrl("cid.apps.googleusercontent.com", "client-secret", NONCE));
  assert.equal(url.searchParams.get("scope"), DRIVE_SCOPE);
  assert.equal(url.searchParams.get("redirect_uri"), LOOPBACK_REDIRECT);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("state"), NONCE);
  assert.equal(url.searchParams.get("code_challenge"), pkceChallenge(pkceVerifier("client-secret", NONCE)));
  assert.doesNotMatch(url.toString(), /client-secret|client_secret/);
  const v = pkceVerifier("client-secret", NONCE);
  assert.ok(v.length >= 43 && v.length <= 128 && /^[A-Za-z0-9_-]+$/.test(v), "RFC 7636 verifier");
  assert.notEqual(pkceVerifier("otro-secreto", NONCE), v, "without the client secret the verifier cannot be derived");
  assert.throws(() => consentUrl("c", "s", "nope"));
});

test("OAuth desde Actions: la dirección pegada se valida y el canje usa el mismo verificador", () => {
  assert.deepEqual(parseRedirect(`http://127.0.0.1:8765/callback?state=${NONCE}&code=4/0AbCdEfGhIj-kl_mn&scope=x`), { ok: true, code: "4/0AbCdEfGhIj-kl_mn", nonce: NONCE });
  assert.equal(parseRedirect("https://evil.example/callback?state=x&code=y").ok, false);
  assert.match((parseRedirect(`http://127.0.0.1:8765/callback?error=access_denied&state=${NONCE}`) as { reason: string }).reason, /access_denied/);
  assert.equal(parseRedirect(`http://127.0.0.1:8765/callback?code=4/abcdefghijk`).ok, false, "state required");
  assert.equal(parseRedirect("no es url").ok, false);
  const body = new URLSearchParams(tokenRequestBody({ code: "4/abcdefghijk", nonce: NONCE, clientId: "cid", clientSecret: "client-secret" }));
  assert.equal(body.get("code_verifier"), pkceVerifier("client-secret", NONCE));
  assert.equal(body.get("redirect_uri"), LOOPBACK_REDIRECT);
  assert.equal(body.get("grant_type"), "authorization_code");
});

test("OAuth desde Actions: exige token de renovación con Drive completo", () => {
  assert.deepEqual(checkTokenResponse(200, { refresh_token: "r", scope: `${DRIVE_SCOPE} openid` }), { ok: true, refreshToken: "r" });
  assert.equal(checkTokenResponse(200, { scope: DRIVE_SCOPE }).ok, false);
  assert.match((checkTokenResponse(200, { refresh_token: "r", scope: "https://www.googleapis.com/auth/drive.file" }) as { reason: string }).reason, /Drive completo/);
  assert.match((checkTokenResponse(400, { error: "invalid_grant" }) as { reason: string }).reason, /invalid_grant/);
});

test("OAuth desde Actions: flujo manual que lee la dirección del evento (no de env), revoca y nunca imprime el token", () => {
  const wf = readFileSync(".github/workflows/drive-oauth.yml", "utf8");
  assert.match(wf, /on:\n\s+workflow_dispatch:/);
  assert.doesNotMatch(wf, /schedule:|push:|redirect_url \}\}/, "the pasted address never goes through env or the script text");
  assert.match(wf, /GH_TOKEN: \$\{\{ secrets\.ORCH_SECRETS_WRITER_TOKEN \}\}/);
  const sc = readFileSync("scripts/orchestrator/google-oauth-actions.ts", "utf8");
  assert.match(sc, /GITHUB_EVENT_PATH/);
  assert.match(sc, /add-mask::\$\{body\.refresh_token\}/);
  assert.match(sc, /secret", "set", "GOOGLE_OAUTH_REFRESH_TOKEN"[\s\S]*input: check\.refreshToken/, "value on stdin, never argv");
  assert.match(sc, /ownedByMe !== true[\s\S]*revoke\(\)/);
  assert.doesNotMatch(sc, /console\.log\([^)]*refreshToken|console\.log\([^)]*access_token\)/);
  assert.doesNotMatch(readFileSync("scripts/orchestrator/google-oauth-consent.ts", "utf8"), /@gmail\.com/, "no personal address in a public repository");
});

test("humo: una sola vez por repositorio, por historial de ejecuciones", () => {
  const runs = [{ id: 1, display_title: "Orchestrator live", conclusion: "success" }, { id: 2, display_title: SMOKE_RUN_TITLE, conclusion: "failure" }];
  assert.equal(smokeAlreadyDone(runs, 9), false, "a smoke run that sent nothing does not count");
  assert.equal(smokeAlreadyDone([...runs, { id: 3, display_title: SMOKE_RUN_TITLE, conclusion: "success" }], 9), true);
  assert.equal(smokeAlreadyDone([{ id: 9, display_title: SMOKE_RUN_TITLE, conclusion: "success" }], 9), false, "the current run itself");
  assert.equal(smokeCallSent([{ state: "released" }]), false, "4xx before generation: nothing charged");
  assert.equal(smokeCallSent([{ state: "settled" }]), true);
  assert.equal(smokeCallSent([{ state: "reserved" }]), true, "outcome unknown counts as sent");
  const wf = readFileSync(".github/workflows/orchestrator.yml", "utf8");
  assert.match(wf, /run-name: .*inputs\.mode == 'smoke' && inputs\.paid_approval == 'HUMO-0\.05USD' && 'Orchestrator smoke \(paid\)'/);
  assert.match(wf, /actions: read/);
  assert.match(wf, /OPENAI_API_KEY: \$\{\{ \(vars\.ORCH_ALLOW_PAID_CALLS == 'true' && inputs\.mode != 'preflight'/, "preflight never receives the key");
});

test("humo: comprobación previa sin envío; peor caso muy por debajo del tope; proyecto de la clave enmascarado", () => {
  const env = { ORCHESTRATOR_ENABLED: "true", ORCH_ALLOW_PAID_CALLS: "true", ORCH_PAID_APPROVAL: SMOKE_APPROVAL, OPENAI_API_KEY: "present" };
  const cfg = { ...loadConfig(env, { durableStore: false, smoke: true }), maxHttpRetries: 0 };
  const req = buildRequest(cfg, { task: "x".repeat(300), delivery: "y".repeat(100), attempt: 1, maxAttempts: 3 });
  const chars = req.input.reduce((n, m) => n + m.content.length, 0);
  const p = smokePreflight(cfg, chars);
  assert.equal(p.wouldCall, true);
  assert.equal(p.model, "gpt-5.6-luna");
  assert.ok(p.worstCaseUsd! > 0 && p.worstCaseUsd! < 0.005, `worst case ${p.worstCaseUsd}`);
  assert.equal(p.capUsd, 0.05);
  const blocked = smokePreflight({ ...loadConfig({ ...env, ORCH_ALLOW_PAID_CALLS: "false" }, { durableStore: false, smoke: true }) }, chars);
  assert.equal(blocked.wouldCall, false);
  assert.match(blocked.blockedReason!, /ORCH_ALLOW_PAID_CALLS/);
  const h = new Headers({ "openai-project": "proj_abcdef123456", "openai-organization": "org-xyz9876", "x-request-id": "req_1" });
  assert.deepEqual(identityFromHeaders(h), { project: "…3456", organization: "…9876", requestId: "req_1" });
  assert.deepEqual(identityFromHeaders(new Headers()), { project: null, organization: null, requestId: null });
});
