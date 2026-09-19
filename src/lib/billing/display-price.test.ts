import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { displayPrice } from "./display-price";
import { monthlyVideoLimit, monthStartUtc } from "./quota-window";
const price = { active: true, livemode: false, type: "recurring", unit_amount: 1999, currency: "usd", billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, tax_behavior: "inclusive" } as Stripe.Price;
test("price uses Stripe amount, currency, renewal and tax status", () => {
  const result = displayPrice(price)!;
  assert.match(result.amount, /USD/); assert.match(result.amount, /19.99/);
  assert.equal(result.period, "cada 1 mes(es)"); assert.equal(result.taxes, "Impuestos incluidos.");
  assert.match(displayPrice({ ...price, currency: "jpy", unit_amount: 2000 })!.amount, /2,000/);
});
test("rejects live, inactive and unsupported prices", () => {
  for (const change of [{ livemode: true }, { active: false }, { unit_amount: null }, { type: "one_time" }, { billing_scheme: "tiered" }]) assert.equal(displayPrice({ ...price, ...change } as Stripe.Price), null);
});
test("quota is calendar month UTC and invalid limits fail closed", () => {
  assert.equal(monthStartUtc(new Date("2026-10-01T00:10:00Z")), "2026-10-01T00:00:00.000Z");
  assert.equal(monthlyVideoLimit("30"), 30);
  for (const input of ["-1", "0", "NaN", "1.5"]) assert.throws(() => monthlyVideoLimit(input));
});
