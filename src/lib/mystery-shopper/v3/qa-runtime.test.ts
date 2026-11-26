import test from "node:test";
import assert from "node:assert/strict";
import { preflight } from "../../../../scripts/mystery-shopper/qa-preflight";
const env = { SUPABASE_URL: "https://qa.example.test", SUPABASE_SERVICE_ROLE_KEY: "fixture-service", MYSTERY_SHOPPER_QA_EMAIL: "qa@example.test", MYSTERY_SHOPPER_QA_PASSWORD: "fixture-password" };
function transport(status: number, logoutStatus = 204) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push(url); assert.ok(init?.signal, "all requests bounded");
    if (url.includes("/admin/users")) return Response.json({ users: [{ id: "fixture", email: env.MYSTERY_SHOPPER_QA_EMAIL, email_confirmed_at: "2026-11-24T00:00:00Z", app_metadata: {} }] });
    if (url.includes("/token?")) return Response.json(status === 200 ? { access_token: "fixture-token" } : { error: "fixture" }, { status });
    assert.equal(new URL(url).searchParams.get("scope"), "local", "must not revoke other sessions");
    return new Response(null, { status: logoutStatus });
  }) as typeof fetch;
  return { calls, fetcher };
}
test("QA diagnostic identifies missing bindings without making requests", async () => {
  const t = transport(200); const r = await preflight({ SUPABASE_URL: env.SUPABASE_URL }, t.fetcher);
  assert.equal(r.secrets_present, false); assert.equal(t.calls.length, 0);
  assert.deepEqual(r.bindings, { supabase_url: true, service_role: false, qa_email: false, qa_password: false });
});
test("QA valid password closes only diagnostic session and leaks no credentials", async () => {
  const t = transport(200); const r = await preflight(env, t.fetcher);
  assert.equal(r.password_ok, true); assert.equal(r.logout_ok, true); assert.equal(t.calls.length, 3);
  for (const secret of Object.values(env)) assert.ok(!JSON.stringify(r).includes(secret));
});
test("QA rate limit and server errors are not diagnosed as wrong passwords; no retries", async () => {
  for (const status of [429, 503]) {
    const t = transport(status); const r = await preflight(env, t.fetcher);
    assert.equal(r.password_ok, null); assert.equal(r.auth_status, status); assert.equal(t.calls.length, 2);
    assert.doesNotMatch(r.diagnosis, /contraseña.*no coincide/);
  }
});
test("QA logout failure cannot be presented as a successful diagnostic", async () => {
  const t = transport(200, 503); const r = await preflight(env, t.fetcher);
  assert.equal(r.logout_ok, false); assert.match(r.diagnosis, /no se confirmó el cierre/);
});
