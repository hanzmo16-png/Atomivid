import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAN_CONFIGS, PLAN_ORDER, getPlanByPriceId, getPlanPriceId, planPriceIdEnvVar } from "./plans";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) originals[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("planPriceIdEnvVar devuelve el nombre de variable esperado por plan", () => {
  assert.equal(planPriceIdEnvVar("starter"), "STRIPE_PRICE_ID_STARTER");
  assert.equal(planPriceIdEnvVar("pro"), "STRIPE_PRICE_ID_PRO");
  assert.equal(planPriceIdEnvVar("business"), "STRIPE_PRICE_ID_BUSINESS");
});

test("getPlanPriceId lee la variable de entorno correspondiente, undefined si no está configurada", () => {
  withEnv({ STRIPE_PRICE_ID_STARTER: undefined }, () => {
    assert.equal(getPlanPriceId("starter"), undefined);
  });
  withEnv({ STRIPE_PRICE_ID_STARTER: "price_abc" }, () => {
    assert.equal(getPlanPriceId("starter"), "price_abc");
  });
});

test("getPlanByPriceId resuelve el plan correcto cuando el price_id coincide", () => {
  withEnv(
    { STRIPE_PRICE_ID_STARTER: "price_s", STRIPE_PRICE_ID_PRO: "price_p", STRIPE_PRICE_ID_BUSINESS: "price_b" },
    () => {
      assert.equal(getPlanByPriceId("price_p")?.id, "pro");
      assert.equal(getPlanByPriceId("price_b")?.id, "business");
    },
  );
});

test("getPlanByPriceId devuelve null para un price_id desconocido o null/undefined", () => {
  assert.equal(getPlanByPriceId("price_no_existe"), null);
  assert.equal(getPlanByPriceId(null), null);
  assert.equal(getPlanByPriceId(undefined), null);
});

test("cada plan tiene cuota de avatar menor o igual a la cuota normal, y Starter no incluye avatar", () => {
  for (const id of PLAN_ORDER) {
    const plan = PLAN_CONFIGS[id];
    assert.ok(plan.monthlyAvatarLimit <= plan.monthlyNormalLimit);
  }
  assert.equal(PLAN_CONFIGS.starter.monthlyAvatarLimit, 0);
});

test("los planes están ordenados de menor a mayor precio", () => {
  const prices = PLAN_ORDER.map((id) => PLAN_CONFIGS[id].priceUsdPerMonth);
  const sorted = [...prices].sort((a, b) => a - b);
  assert.deepEqual(prices, sorted);
});
