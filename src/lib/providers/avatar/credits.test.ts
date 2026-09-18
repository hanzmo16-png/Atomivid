import test from "node:test";
import assert from "node:assert/strict";
import { readDidCredits } from "./credits";
test("balance query is GET-only, private and strips identities", async () => {
  let calls = 0;
  const result = await readDidCredits("test:credential", async (url, options) => {
    calls++; assert.equal(url, "https://api.d-id.com/credits"); assert.equal(options?.method, "GET");
    assert.equal(options?.redirect, "error"); assert.equal(options?.cache, "no-store");
    return Response.json({ credits: [{ remaining: 9, total: 20, expire_at: "2027-01-01", owner_id: "private-owner", email: "private@example.test" }] });
  });
  assert.equal(calls, 1); assert.equal(result.authenticated, true);
  assert.deepEqual(result.credits, { credits: [{ remaining: 9, total: 20, expire_at: "2027-01-01" }] });
  assert.ok(!JSON.stringify(result).includes("private"));
});
test("missing key makes no call; authorization failures do not expose body", async () => {
  assert.equal((await readDidCredits(undefined, async () => { throw new Error("must not call"); })).error, "missing_key");
  assert.deepEqual(await readDidCredits("x", async () => new Response("private-account", { status: 401 })), { authenticated: false, status: 401 });
});
