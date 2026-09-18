import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDidAccess } from "./check-did-access.mjs";

test("missing D-ID key performs no request", async () => {
  const result = await checkDidAccess(undefined, () => { throw new Error("must not call"); });
  assert.deepEqual(result, { configured: false, authenticated: false, reason: "missing_key" });
});
for (const status of [200, 401, 403, 500]) {
  test(`D-ID check is read-only and redacted (${status})`, async () => {
    let calls = 0;
    const result = await checkDidAccess("user:private-value", async (url, options) => {
      calls++;
      assert.equal(url, "https://api.d-id.com/credits");
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Basic " + Buffer.from("user:private-value").toString("base64"));
      return new Response("private-credit-account-data", { status });
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, { configured: true, authenticated: status === 200, status });
    assert.ok(!JSON.stringify(result).includes("private"));
  });
}
test("network failures do not expose credentials", async () => {
  assert.deepEqual(await checkDidAccess("secret", async () => { throw new Error("secret"); }),
    { configured: true, authenticated: false, reason: "connection_failed" });
});
