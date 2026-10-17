/**
 * The worker-credential probe is one GET on api.github.com and nothing else: it must tell 200/401/403/404 apart
 * as `readAuth`, keep `dispatchPermission` as "unverified" in every case, surface GitHub's expiration header and
 * reported permissions, refuse a malformed repository before building any URL, and never leak the token or the
 * repository name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validWorkerAuthSignature, workerAuthProbe, workerAuthSignature } from "./worker-auth";

const TOKEN = "github_pat_SYNTHETIC_0000000000000000000000";
const REPO = "owner-x/repo-y";
const SECRET = "s".repeat(40), NONCE = "6b4b3c1e-0000-4000-8000-000000000002";

function fakeGithub(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  const calls: { url: string; method: string; auth: string | null; redirect: string | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
    return new Response(JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("firma: válida solo con secreto, nonce y hora correctos; ligada a la ruta worker-auth", () => {
  const ts = String(Date.now());
  assert.ok(validWorkerAuthSignature(SECRET, NONCE, ts, workerAuthSignature(SECRET, NONCE, ts)));
  assert.ok(!validWorkerAuthSignature(SECRET, NONCE, ts, workerAuthSignature("x".repeat(40), NONCE, ts)));
  assert.ok(!validWorkerAuthSignature(SECRET, NONCE, String(Date.now() - 400_000), workerAuthSignature(SECRET, NONCE, String(Date.now() - 400_000))));
  assert.ok(!validWorkerAuthSignature(undefined, NONCE, ts, workerAuthSignature(SECRET, NONCE, ts)));
  assert.ok(!validWorkerAuthSignature("short", NONCE, ts, workerAuthSignature("short", NONCE, ts)));
});

test("200 con permisos y caducidad → readAuth accepted, dispatchPermission sigue unverified; un solo GET sin redirecciones; sin token ni repo en el informe", async () => {
  const gh = fakeGithub(200, { permissions: { admin: true, push: true, pull: true } }, { "github-authentication-token-expiration": "2026-11-16 14:32:07 UTC" });
  const r = await workerAuthProbe({ GH_WORKER_TOKEN: ` ${TOKEN} `, GH_WORKER_REPO: REPO }, gh.fetchImpl);
  assert.deepEqual({ ...r, note: undefined }, { configured: { token: "present", repo: "present" }, readAuth: "accepted", http: 200, transportError: false,
    reportedPermissions: { admin: true, push: true, pull: true }, tokenExpiresAt: "2026-11-16 14:32:07 UTC", dispatchPermission: "unverified", note: undefined });
  assert.match(r.note, /not verified/);
  assert.deepEqual(gh.calls, [{ url: `https://api.github.com/repos/${REPO}`, method: "GET", auth: `Bearer ${TOKEN}`, redirect: "error" }]);
  assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC|owner-x|repo-y/);
});

test("401 → refused_401, 403 → forbidden_403, 404 → not_found_404, 5xx → unknown; nunca permisos ni dispatch verificado", async () => {
  for (const [status, readAuth] of [[401, "refused_401"], [403, "forbidden_403"], [404, "not_found_404"], [500, "unknown"]] as const) {
    const r = await workerAuthProbe({ GH_WORKER_TOKEN: TOKEN, GH_WORKER_REPO: REPO }, fakeGithub(status, { message: "Bad credentials" }).fetchImpl);
    assert.equal(r.readAuth, readAuth, String(status));
    assert.equal(r.http, status);
    assert.equal(r.reportedPermissions, null);
    assert.equal(r.dispatchPermission, "unverified");
  }
});

test("sin token, token en blanco, repo ausente o repo no estricto (URL, query, fragmento, codificación, navegación) → not_checked sin llamar a GitHub", async () => {
  const gh = fakeGithub(200);
  for (const env of [{ GH_WORKER_REPO: REPO }, { GH_WORKER_TOKEN: "  ", GH_WORKER_REPO: REPO }, { GH_WORKER_TOKEN: TOKEN },
    ...["https://github.com/owner/repo", "owner/repo?x=1", "owner/repo#f", "owner/re%2Fpo", "owner/../x", "owner/repo/extra"].map((GH_WORKER_REPO) => ({ GH_WORKER_TOKEN: TOKEN, GH_WORKER_REPO }))]) {
    const r = await workerAuthProbe(env, gh.fetchImpl);
    assert.equal(r.readAuth, "not_checked", JSON.stringify(env.GH_WORKER_REPO ?? Object.keys(env)));
    assert.equal(r.http, null);
  }
  assert.equal(gh.calls.length, 0, "nothing is sent while the configuration is incomplete or malformed");
  assert.equal((await workerAuthProbe({ GH_WORKER_TOKEN: TOKEN, GH_WORKER_REPO: "owner/repo?x=1" }, gh.fetchImpl)).configured.repo, "invalid");
});

test("fallo de red o timeout → unknown con transportError, nunca una excepción", async () => {
  const fetchImpl = (async () => { throw new Error("socket hang up"); }) as typeof fetch;
  const r = await workerAuthProbe({ GH_WORKER_TOKEN: TOKEN, GH_WORKER_REPO: REPO }, fetchImpl);
  assert.deepEqual([r.readAuth, r.transportError, r.http, r.dispatchPermission], ["unknown", true, null, "unverified"]);
});
