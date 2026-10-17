/**
 * The REAL route handler, exercised with the global fetch replaced by a recorder: a signed call must produce exactly
 * one GET to api.github.com and no other network call of any kind (so no Supabase read or write, no storage, no
 * provider); an unsigned call must answer 401 without any network call; the answer must carry the environment scope
 * and never a secret or the repository name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { POST } from "./route";
import { WORKER_AUTH_PATH, workerAuthSignature } from "@/lib/ops/worker-auth";

const KEY = "service-role-" + "k".repeat(48);
const TOKEN = "github_pat_SYNTHETIC_ROUTE_0000000000000000";
const ENV_KEYS = ["SUPABASE_SERVICE_ROLE_KEY", "GH_WORKER_TOKEN", "GH_WORKER_REPO", "VERCEL_ENV", "VERCEL_GIT_COMMIT_SHA"] as const;

async function withEnvAndFetch<T>(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, status: number, fn: (calls: { url: string; method: string }[]) => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const origFetch = globalThis.fetch;
  const calls: { url: string; method: string }[] = [];
  for (const k of ENV_KEYS) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ permissions: { admin: false, push: true, pull: true } }), { status, headers: { "github-authentication-token-expiration": "2026-12-01 00:00:00 UTC" } });
  }) as typeof fetch;
  try { return await fn(calls); } finally {
    globalThis.fetch = origFetch;
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
  }
}

const signed = (key: string) => {
  const nonce = randomUUID(), ts = String(Date.now());
  return new Request(`https://example.test${WORKER_AUTH_PATH}`, { method: "POST", headers: { "x-probe-nonce": nonce, "x-probe-time": ts, "x-probe-signature": workerAuthSignature(key, nonce, ts) } });
};

test("ruta real firmada: exactamente un GET a api.github.com y ninguna otra llamada de red; respuesta con entorno y sin valores", async () => {
  await withEnvAndFetch({ SUPABASE_SERVICE_ROLE_KEY: KEY, GH_WORKER_TOKEN: TOKEN, GH_WORKER_REPO: "owner-r/repo-r", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "abcdef0123456789" }, 200, async (calls) => {
    const res = await POST(signed(KEY));
    assert.equal(res.status, 200);
    const body = await res.json() as { environment: { vercelEnv: string; commit: string; scope: string }; githubWorker: { readAuth: string; dispatchPermission: string; reportedPermissions: { push: boolean } } };
    assert.deepEqual(body.environment, { vercelEnv: "preview", commit: "abcdef0", scope: "this deployment only" });
    assert.equal(body.githubWorker.readAuth, "accepted");
    assert.equal(body.githubWorker.dispatchPermission, "unverified");
    assert.equal(body.githubWorker.reportedPermissions.push, true);
    assert.deepEqual(calls, [{ url: "https://api.github.com/repos/owner-r/repo-r", method: "GET" }], "no Supabase, storage, provider or write call of any kind");
    assert.doesNotMatch(JSON.stringify(body), /SYNTHETIC|owner-r|repo-r|service-role/);
  });
});

test("ruta real sin firma válida: 401 y cero llamadas de red", async () => {
  await withEnvAndFetch({ SUPABASE_SERVICE_ROLE_KEY: KEY, GH_WORKER_TOKEN: TOKEN, GH_WORKER_REPO: "owner-r/repo-r" }, 200, async (calls) => {
    for (const req of [new Request(`https://example.test${WORKER_AUTH_PATH}`, { method: "POST" }), signed("wrong-key-" + "w".repeat(40))]) {
      const res = await POST(req);
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: "Unauthorized" });
    }
    assert.equal(calls.length, 0);
  });
});

test("ruta real con 401 de GitHub: readAuth refused_401, sin permisos, dispatch sigue unverified", async () => {
  await withEnvAndFetch({ SUPABASE_SERVICE_ROLE_KEY: KEY, GH_WORKER_TOKEN: TOKEN, GH_WORKER_REPO: "owner-r/repo-r" }, 401, async (calls) => {
    const body = await (await POST(signed(KEY))).json() as { githubWorker: { readAuth: string; http: number; reportedPermissions: unknown; dispatchPermission: string } };
    assert.deepEqual([body.githubWorker.readAuth, body.githubWorker.http, body.githubWorker.reportedPermissions, body.githubWorker.dispatchPermission], ["refused_401", 401, null, "unverified"]);
    assert.equal(calls.length, 1);
  });
});
