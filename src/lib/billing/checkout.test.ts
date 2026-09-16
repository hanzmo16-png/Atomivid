import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCheckoutUrl } from "./checkout";
import { CheckoutUrlMissingError } from "./checkout-error";

const FAKE_PRICE_ID = "price_FAKEVALUEFORTESTINGONLY";
const FAKE_SITE_URL = "https://atomivid.example.test";
const FAKE_USER = { id: "user-123", email: "user@example.test" };

test("buildCheckoutUrl crea una Checkout Session simulada y devuelve su URL", async () => {
  let capturedParams: unknown = null;

  const url = await buildCheckoutUrl(FAKE_USER, {
    createCheckoutSession: async (params) => {
      capturedParams = params;
      return { url: "https://checkout.stripe.test/fake-session" } as Awaited<
        ReturnType<Parameters<typeof buildCheckoutUrl>[1]["createCheckoutSession"]>
      >;
    },
    getExistingCustomerId: async () => null,
    priceId: FAKE_PRICE_ID,
    siteUrl: FAKE_SITE_URL,
  });

  assert.equal(url, "https://checkout.stripe.test/fake-session");
  assert.deepEqual(capturedParams, {
    mode: "subscription",
    line_items: [{ price: FAKE_PRICE_ID, quantity: 1 }],
    client_reference_id: FAKE_USER.id,
    customer: undefined,
    customer_email: FAKE_USER.email,
    subscription_data: { metadata: { supabase_user_id: FAKE_USER.id } },
    success_url: `${FAKE_SITE_URL}/dashboard/billing?checkout=success`,
    cancel_url: `${FAKE_SITE_URL}/dashboard/billing?checkout=canceled`,
  });
});

test("buildCheckoutUrl reutiliza el customer existente en vez de customer_email", async () => {
  let capturedParams: unknown = null;

  await buildCheckoutUrl(FAKE_USER, {
    createCheckoutSession: async (params) => {
      capturedParams = params;
      return { url: "https://checkout.stripe.test/fake-session" } as Awaited<
        ReturnType<Parameters<typeof buildCheckoutUrl>[1]["createCheckoutSession"]>
      >;
    },
    getExistingCustomerId: async () => "cus_existing123",
    priceId: FAKE_PRICE_ID,
    siteUrl: FAKE_SITE_URL,
  });

  const params = capturedParams as { customer?: string; customer_email?: string };
  assert.equal(params.customer, "cus_existing123");
  assert.equal(params.customer_email, undefined);
});

test("buildCheckoutUrl lanza CheckoutUrlMissingError si Stripe no devuelve session.url", async () => {
  await assert.rejects(
    () =>
      buildCheckoutUrl(FAKE_USER, {
        createCheckoutSession: async () =>
          ({ url: null }) as Awaited<
            ReturnType<Parameters<typeof buildCheckoutUrl>[1]["createCheckoutSession"]>
          >,
        getExistingCustomerId: async () => null,
        priceId: FAKE_PRICE_ID,
        siteUrl: FAKE_SITE_URL,
      }),
    CheckoutUrlMissingError,
  );
});

test("buildCheckoutUrl propaga el error si la búsqueda del customer falla", async () => {
  await assert.rejects(
    () =>
      buildCheckoutUrl(FAKE_USER, {
        createCheckoutSession: async () => {
          throw new Error("no debería llamarse a Stripe si falló Supabase antes");
        },
        getExistingCustomerId: async () => {
          throw new Error("fallo simulado de Supabase");
        },
        priceId: FAKE_PRICE_ID,
        siteUrl: FAKE_SITE_URL,
      }),
    /fallo simulado de Supabase/,
  );
});
