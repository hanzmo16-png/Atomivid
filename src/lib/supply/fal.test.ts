import { test } from "node:test";
import assert from "node:assert/strict";
import { falApiSnapshot, falBillingKey } from "./fal";
import { refreshProviderSnapshot } from "./monitor";

const at = "2026-10-21T15:00:00.000Z";
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

test("fal billing: USD credits from the official endpoint become a provider_api balance; key only in the header", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ credits: { current_balance: 9.96, currency: "USD" } })); }) as unknown as typeof fetch;
  const s = await falApiSnapshot(fetchImpl, { FAL_ADMIN_KEY: "admin-secret" }, at);
  assert.deepEqual([s.provider, s.unit, s.available, s.health, s.reliability], ["recraft", "usd", 9.96, "OK", "provider_api"]);
  assert.equal(seen!.url, "https://api.fal.ai/v1/account/billing?expand=credits");
  assert.equal(seen!.init.method, "GET");
  assert.equal((seen!.init.headers as Record<string, string>).Authorization, "Key admin-secret");
  assert.doesNotMatch(JSON.stringify(s), /admin-secret/);
});

test("fal billing: refused key (401/403), 5xx, other currency or malformed balance are never a balance", async () => {
  for (const [status, body, health] of [[401, {}, "DOWN"], [403, {}, "DOWN"], [503, {}, "DEGRADED"], [200, { credits: { current_balance: 5, currency: "EUR" } }, "DEGRADED"],
    [200, { credits: { current_balance: "9.96", currency: "USD" } }, "DEGRADED"], [200, { credits: { current_balance: -1, currency: "USD" } }, "DEGRADED"], [200, {}, "DEGRADED"]] as const) {
    const s = await falApiSnapshot(reply(status, body), { FAL_ADMIN_KEY: "k" }, at);
    assert.equal(s.available, null, `${status} ${JSON.stringify(body)}`);
    assert.equal(s.reliability, "none");
    assert.equal(s.health, health);
  }
  const thrown = await falApiSnapshot((async () => { throw new Error("network"); }) as typeof fetch, { FAL_ADMIN_KEY: "k" }, at);
  assert.deepEqual([thrown.available, thrown.health], [null, "DEGRADED"]);
});

test("fal billing: no admin key means no request and nothing stored; FAL_KEY alone is never used for billing", async () => {
  let calls = 0;
  const s = await falApiSnapshot((async () => { calls++; return new Response("{}"); }) as typeof fetch, {}, at);
  assert.deepEqual([calls, s.health, s.available], [0, "UNCHECKED", null]);
  assert.equal(falBillingKey({ FAL_KEY: " api ", FAL_ADMIN_KEY: " admin " }), "admin");
  assert.equal(falBillingKey({ FAL_KEY: " api " }), null);
  assert.equal(falBillingKey({ FAL_ADMIN_KEY: "  " }), null);
});

test("refreshProviderSnapshot('recraft') persists exactly one GET-only observation, timestamped before the request", async () => {
  const inserted: Record<string, unknown>[] = [];
  const service = { from: () => ({ insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; } }) };
  const methods: string[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => { methods.push(String(init.method)); return new Response(JSON.stringify({ credits: { current_balance: 4.2, currency: "USD" } })); }) as unknown as typeof fetch;
  assert.equal(await refreshProviderSnapshot(service as never, "recraft", { env: { FAL_ADMIN_KEY: "a" }, fetchImpl, now: () => Date.parse(at) }), true);
  assert.deepEqual(methods, ["GET"]);
  assert.equal(inserted.length, 1);
  assert.deepEqual([inserted[0].provider, inserted[0].unit, inserted[0].available, inserted[0].reliability, inserted[0].checked_at], ["recraft", "usd", 4.2, "provider_api", at]);
  assert.equal(await refreshProviderSnapshot(service as never, "recraft", { env: { FAL_KEY: "api-scoped" }, fetchImpl, now: () => Date.parse(at) }), false, "only FAL_KEY: nothing read, nothing stored");
  assert.equal(inserted.length, 1);
});
