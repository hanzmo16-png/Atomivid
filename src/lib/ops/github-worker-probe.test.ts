/**
 * The worker-credential probe is a GET only: it must tell 200/401/403/404 apart, surface GitHub's own expiration
 * header and the reported repository permissions, and never leak the token or the repository name. It never
 * sends anything but one GET to /repos/{repo}: no POST, no dispatch, no spend.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { githubWorkerProbe, providerConfigReport } from "./provider-config";
import { resetVoiceCache } from "@/lib/podcast/voices";

const TOKEN = "github_pat_SYNTHETIC_0000000000000000000000";
const REPO = "owner-x/repo-y";

function fakeGithub(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  const calls: { url: string; method: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url: String(url), method: init?.method ?? "GET", auth: h.get("authorization") });
    if (String(url).includes("api.github.com")) return new Response(JSON.stringify(body), { status, headers });
    return new Response(JSON.stringify({ voices: [] }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("200 con permisos y cabecera de caducidad → GO_READ; solo un GET a /repos; sin token ni repo en el informe", async () => {
  const gh = fakeGithub(200, { permissions: { admin: true, push: true, pull: true } }, { "github-authentication-token-expiration": "2026-11-16 14:32:07 UTC" });
  const r = await githubWorkerProbe({ GH_WORKER_TOKEN: ` ${TOKEN} `, GH_WORKER_REPO: REPO }, gh.fetchImpl);
  assert.deepEqual(r, { token: "present", repo: "present", http: 200, transportError: false, permissions: { admin: true, push: true, pull: true }, tokenExpiresAt: "2026-11-16 14:32:07 UTC", verdict: "GO_READ" });
  assert.deepEqual(gh.calls, [{ url: `https://api.github.com/repos/${REPO}`, method: "GET", auth: `Bearer ${TOKEN}` }]);
  assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC|owner-x|repo-y/);
});

test("401 → NO_GO_401 (credencial rechazada), 403 → NO_GO_403, 404 → NO_GO_404, 5xx → UNKNOWN; sin permisos en la respuesta", async () => {
  for (const [status, verdict] of [[401, "NO_GO_401"], [403, "NO_GO_403"], [404, "NO_GO_404"], [500, "UNKNOWN"]] as const) {
    const r = await githubWorkerProbe({ GH_WORKER_TOKEN: TOKEN, GH_WORKER_REPO: REPO }, fakeGithub(status, { message: "Bad credentials" }).fetchImpl);
    assert.equal(r.verdict, verdict, String(status));
    assert.equal(r.http, status);
    assert.equal(r.permissions, null);
  }
});

test("sin token, token en blanco, repo ausente o repo mal formado → NOT_CONFIGURED sin llamar a GitHub", async () => {
  const gh = fakeGithub(200);
  for (const env of [{ GH_WORKER_REPO: REPO }, { GH_WORKER_TOKEN: "  ", GH_WORKER_REPO: REPO }, { GH_WORKER_TOKEN: TOKEN }, { GH_WORKER_TOKEN: TOKEN, GH_WORKER_REPO: "https://github.com/owner/repo" }]) {
    const r = await githubWorkerProbe(env, gh.fetchImpl);
    assert.equal(r.verdict, "NOT_CONFIGURED", JSON.stringify(Object.keys(env)));
    assert.equal(r.http, null);
  }
  assert.equal(gh.calls.length, 0, "nothing is sent while the configuration is incomplete");
  assert.equal((await githubWorkerProbe({ GH_WORKER_TOKEN: TOKEN, GH_WORKER_REPO: "https://github.com/owner/repo" }, gh.fetchImpl)).repo, "invalid");
});

test("fallo de red o timeout → UNKNOWN con transportError, nunca una excepción", async () => {
  const fetchImpl = (async () => { throw new Error("socket hang up"); }) as typeof fetch;
  const r = await githubWorkerProbe({ GH_WORKER_TOKEN: TOKEN, GH_WORKER_REPO: REPO }, fetchImpl);
  assert.deepEqual([r.verdict, r.transportError, r.http], ["UNKNOWN", true, null]);
});

test("el informe firmado incluye githubWorker y sigue sin exponer ningún valor", async () => {
  resetVoiceCache();
  const gh = fakeGithub(401, { message: "Bad credentials" });
  const r = await providerConfigReport({ GH_WORKER_TOKEN: TOKEN, GH_WORKER_REPO: REPO, ELEVENLABS_API_KEY: "sk_" + "b".repeat(40) }, gh.fetchImpl);
  assert.equal(r.githubWorker.verdict, "NO_GO_401");
  assert.equal(r.keys.GH_WORKER_TOKEN, "present");
  assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC|owner-x|sk_b/);
  resetVoiceCache();
});
