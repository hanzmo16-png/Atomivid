import { test } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { handleStripeWebhook, type WebhookDependencies } from "./webhook";

const subscription = {
  id: "sub_test", customer: "cus_test", status: "active",
  metadata: { supabase_user_id: "user-test" },
  items: { data: [{ current_period_end: 1800000000, price: { id: "price_test" } }] },
  cancel_at_period_end: false,
} as unknown as Stripe.Subscription;

function fixture(options: { writeError?: boolean; lookupError?: boolean; stale?: boolean; replacement?: boolean } = {}) {
  const sdk = new Stripe("sk_test_local_only");
  const writes: unknown[] = [];
  let reads = 0;
  const service = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({
        data: options.lookupError ? null : { user_id: "user-test" },
        error: options.lookupError ? { code: "08006", message: "private database detail" } : null,
      }) }) }),
      upsert: async (value: unknown) => {
        writes.push(value);
        return { error: options.writeError ? { code: "08006", message: "private database detail" } : null };
      },
      update: (value: unknown) => ({ eq: (key: string, userId: string) => ({
        eq: async (subKey: string, subId: string) => {
          assert.deepEqual([key, userId, subKey, subId], ["user_id", "user-test", "stripe_subscription_id", "sub_test"]);
          if (!options.replacement) writes.push(value);
          return { error: options.writeError ? { code: "08006" } : null };
        },
      }) }),
    }),
  } as unknown as ReturnType<WebhookDependencies["service"]>;
  const deps: WebhookDependencies = {
    stripe: () => ({ webhooks: sdk.webhooks, subscriptions: {
      retrieve: async () => { reads++; return { ...subscription, status: options.stale ? "canceled" : "active" }; },
    } as unknown as Stripe["subscriptions"] }),
    service: () => service,
    webhookSecret: () => "whsec_local_only",
  };
  function request(type = "customer.subscription.updated", metadata = subscription.metadata) {
    const payload = JSON.stringify({ id: "evt_test", type, data: { object: { ...subscription, metadata } } });
    return new Request("https://example.test/api/stripe/webhook", {
      method: "POST", body: payload,
      headers: { "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload, secret: "whsec_local_only" }) },
    });
  }
  return { deps, request, writes, reads: () => reads };
}

test("a failed subscription write returns 500 so Stripe can redeliver", async () => {
  const f = fixture({ writeError: true });
  const response = await handleStripeWebhook(f.request(), f.deps);
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private database detail/);
});

test("a customer lookup failure is not acknowledged as an unrelated event", async () => {
  const f = fixture({ lookupError: true });
  const response = await handleStripeWebhook(f.request("customer.subscription.updated", {}), f.deps);
  assert.equal(response.status, 500);
  assert.equal(f.writes.length, 0);
});

test("an out-of-order update uses Stripe's current state, not the old event snapshot", async () => {
  const f = fixture({ stale: true });
  const response = await handleStripeWebhook(f.request(), f.deps);
  assert.equal(response.status, 200);
  assert.equal(f.reads(), 1);
  assert.equal((f.writes[0] as { status: string }).status, "canceled");
});

test("invalid signature never accesses the database or subscription API", async () => {
  const f = fixture();
  const response = await handleStripeWebhook(new Request("https://example.test", {
    method: "POST", body: "private body", headers: { "stripe-signature": "invalid" },
  }), f.deps);
  assert.equal(response.status, 400);
  assert.equal(f.writes.length, 0);
  assert.equal(f.reads(), 0);
  assert.doesNotMatch(await response.text(), /private body/);
});

test("a delayed old cancellation does not overwrite a replacement subscription", async () => {
  const f = fixture({ stale: true, replacement: true });
  const response = await handleStripeWebhook(f.request("customer.subscription.deleted"), f.deps);
  assert.equal(response.status, 200);
  assert.equal(f.writes.length, 0);
});

test("repeated active events safely persist the same subscription without creating payments", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) assert.equal((await handleStripeWebhook(f.request(), f.deps)).status, 200);
  assert.equal(f.writes.length, 2);
  assert.equal((f.writes[0] as { stripe_subscription_id: string }).stripe_subscription_id, "sub_test");
});

test("unsupported events are acknowledged without subscription writes", async () => {
  const f = fixture();
  assert.equal((await handleStripeWebhook(f.request("invoice.created"), f.deps)).status, 200);
  assert.equal(f.writes.length, 0);
  assert.equal(f.reads(), 0);
});
