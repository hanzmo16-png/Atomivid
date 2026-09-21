import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBillingConfig } from "./config-check";

// Deliberadamente cortas y no-alfanuméricas después del prefijo: el
// escáner de secretos de GitHub bloquea cadenas con forma de clave real de
// Stripe (prefijo + ~24+ caracteres base62), incluso en fixtures de
// prueba. checkBillingConfig() solo mira el prefijo (startsWith), así que
// esto prueba exactamente lo mismo sin arriesgar un falso positivo.
const FAKE_TEST_KEY = "sk_test_x";
const FAKE_LIVE_KEY = "sk_live_x";
const FAKE_PRICE_ID = "price_FAKEVALUEFORTESTINGONLY";
const FAKE_PRICE_ID_2 = "price_FAKEVALUEFORTESTINGONLYB";
const FAKE_PRICE_ID_3 = "price_FAKEVALUEFORTESTINGONLYC";
const FAKE_URL = "https://fake-project.supabase.co";
const FAKE_ANON_KEY = "fake-anon-key-value";
const FAKE_SERVICE_ROLE_KEY = "fake-service-role-key-value";

test("checkBillingConfig reporta todo presente y modo test cuando la clave empieza con sk_test_", () => {
  const result = checkBillingConfig({
    STRIPE_SECRET_KEY: FAKE_TEST_KEY,
    STRIPE_PRICE_ID_STARTER: FAKE_PRICE_ID,
    STRIPE_PRICE_ID_PRO: FAKE_PRICE_ID_2,
    STRIPE_PRICE_ID_BUSINESS: FAKE_PRICE_ID_3,
    NEXT_PUBLIC_SUPABASE_URL: FAKE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: FAKE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE_ROLE_KEY,
  });

  assert.deepEqual(result, {
    hasStripeSecretKey: true,
    stripeSecretKeyMode: "test",
    hasPlanPriceId: { starter: true, pro: true, business: true },
    hasSupabaseUrl: true,
    hasSupabaseAnonKey: true,
    hasSupabaseServiceRoleKey: true,
  });
});

test("checkBillingConfig detecta modo live por el prefijo sk_live_", () => {
  const result = checkBillingConfig({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY });
  assert.equal(result.stripeSecretKeyMode, "live");
});

test("checkBillingConfig reporta 'missing' cuando no hay clave de Stripe", () => {
  const result = checkBillingConfig({});
  assert.equal(result.hasStripeSecretKey, false);
  assert.equal(result.stripeSecretKeyMode, "missing");
});

test("checkBillingConfig reporta 'unknown' para un prefijo no reconocido", () => {
  const result = checkBillingConfig({ STRIPE_SECRET_KEY: "not-a-real-stripe-key-format" });
  assert.equal(result.stripeSecretKeyMode, "unknown");
});

test("checkBillingConfig reporta ausencia de cada variable por separado", () => {
  const result = checkBillingConfig({ STRIPE_SECRET_KEY: FAKE_TEST_KEY });
  assert.deepEqual(result.hasPlanPriceId, { starter: false, pro: false, business: false });
  assert.equal(result.hasSupabaseUrl, false);
  assert.equal(result.hasSupabaseAnonKey, false);
  assert.equal(result.hasSupabaseServiceRoleKey, false);
});

test("checkBillingConfig nunca devuelve las cadenas de valor inyectadas, solo booleanos/enum", () => {
  const result = checkBillingConfig({
    STRIPE_SECRET_KEY: FAKE_TEST_KEY,
    STRIPE_PRICE_ID_STARTER: FAKE_PRICE_ID,
    NEXT_PUBLIC_SUPABASE_URL: FAKE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: FAKE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE_ROLE_KEY,
  });

  const serialized = JSON.stringify(result);
  for (const secretValue of [
    FAKE_TEST_KEY,
    FAKE_LIVE_KEY,
    FAKE_PRICE_ID,
    FAKE_URL,
    FAKE_ANON_KEY,
    FAKE_SERVICE_ROLE_KEY,
  ]) {
    assert.ok(!serialized.includes(secretValue), `no debería contener el valor: ${secretValue}`);
  }
});
