import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateObligations, obligationRates, quotaMonthStart, type FinanceRequest } from "./obligations";

const monthStart = "2026-10-01T00:00:00.000Z";
const rates = { reel: 0.75, avatar: 3, longForm: 12 };
function withPrices(fn: () => void) {
  const keys = ["STRIPE_PRICE_ID_STARTER", "STRIPE_PRICE_ID_PRO", "STRIPE_PRICE_ID_BUSINESS"];
  const old = keys.map(k => process.env[k]);
  keys.forEach((k, i) => { process.env[k] = ["starter-test", "pro-test", "business-test"][i]; });
  try { fn(); } finally { keys.forEach((k, i) => { if (old[i] === undefined) delete process.env[k]; else process.env[k] = old[i]; }); }
}
const request = (id: string, user = "u", status = "completed", mode = "visual", created_at = "2026-10-05T00:00:00Z"): FinanceRequest => ({ id, user_id: user, status, mode, created_at });

test("50 Starter customers leave a reserve for every unredeemed video", () => withPrices(() => {
  const subscriptions = Array.from({ length: 50 }, (_, i) => ({ user_id: `u${i}`, status: "active", price_id: "starter-test" }));
  const requests = subscriptions.flatMap(s => Array.from({ length: 5 }, (_, i) => request(`${s.user_id}-${i}`, s.user_id)));
  const r = estimateObligations({ subscriptions, requests, holds: [], rates, monthStart });
  assert.equal(r.remainingReels, 500); assert.equal(r.futureUsd, 375); assert.equal(r.reserveUsd, 487.5);
}));
test("processing uses quota once and its multiple supplier holds are not added twice", () => withPrices(() => {
  const r = estimateObligations({ subscriptions: [{ user_id: "u", status: "active", price_id: "pro-test" }],
    requests: [request("complete"), request("pending", "u", "processing")],
    holds: [{ project_id: "pending", reserved_usd: 2, consumed_usd: 1 }, { project_id: "pending", reserved_usd: 1, consumed_usd: 0 }, { project_id: "orphan", reserved_usd: 4, consumed_usd: 2 }], rates, monthStart });
  assert.equal(r.remainingReels, 28); assert.equal(r.remainingAvatars, 5);
  assert.equal(r.futureUsd, 36); assert.equal(r.processingUsd, 4); assert.equal(r.reserveUsd, 52);
}));
test("old processing work survives month rollover, cancellation and lack of an active subscription", () => {
  const r = estimateObligations({ subscriptions: [{ user_id: "u", status: "canceled", price_id: "x" }], requests: [request("old", "u", "processing", "avatar", "2026-09-30T00:00:00Z")], holds: [], rates, monthStart });
  assert.equal(r.accounts, 0); assert.equal(r.futureUsd, 0); assert.equal(r.processingUsd, 3); assert.equal(r.reserveUsd, 3.9);
});
test("failed attempts do not consume unused entitlements; usage does not go negative", () => withPrices(() => {
  const requests = Array.from({ length: 20 }, (_, i) => request(String(i)));
  requests.push(request("failed", "u", "failed"));
  const r = estimateObligations({ subscriptions: [{ user_id: "u", status: "active", price_id: "starter-test" }], requests, holds: [], rates, monthStart });
  assert.equal(r.remainingReels, 0); assert.equal(r.reserveUsd, 0);
}));
test("unmapped prices keep the financial total unknown and trials are not presented as paid customers", () => {
  const r = estimateObligations({ subscriptions: [{ user_id: "u", status: "trialing", price_id: null }], requests: [], holds: [], rates, monthStart });
  assert.equal(r.unmappedPlans, 1); assert.equal(r.trials, 1); assert.equal(r.futureUsd, null); assert.equal(r.reserveUsd, null);
});
test("private avatar and Long Form access are backed at their full cost", () => withPrices(() => {
  const r = estimateObligations({ subscriptions: [{ user_id: "u", status: "trialing", price_id: "starter-test", avatarLimit: 5, longFormAccess: true }], requests: [], holds: [], rates, monthStart });
  assert.equal(r.futureUsd, 195); assert.equal(r.reserveUsd, 253.5);
  const missing = estimateObligations({ subscriptions: [{ user_id: "u", status: "active", price_id: "starter-test", longFormAccess: true }], requests: [], holds: [], rates: { ...rates, longForm: null }, monthStart });
  assert.equal(missing.reserveUsd, null); assert.deepEqual(missing.missingRates, ["videos largos"]);
}));
test("missing rates and invalid numeric inputs never become a free production allowance", () => {
  assert.deepEqual(obligationRates({ SUPPLY_RESERVE_REEL_USD: "NaN", SUPPLY_RESERVE_AVATAR_USD: "0", SUPPLY_RESERVE_LONG_FORM_USD: "-1" }), { reel: null, avatar: null, longForm: null });
  const r = estimateObligations({ subscriptions: [], requests: [request("pending", "u", "processing")], holds: [], rates: { ...rates, reel: null }, monthStart });
  assert.equal(r.processingUsd, null); assert.equal(r.reserveUsd, null);
  assert.throws(() => estimateObligations({ subscriptions: [], requests: [], holds: [{ project_id: "x", reserved_usd: "Infinity", consumed_usd: 0 }], rates, monthStart }), /INVALID_FINANCE_HOLD/);
});
test("quota boundary is the runtime calendar-month boundary", () => {
  const now = new Date("2026-10-05T16:00:00Z"), expected = new Date(now);
  expected.setDate(1); expected.setHours(0, 0, 0, 0);
  assert.equal(quotaMonthStart(now), expected.toISOString());
});
