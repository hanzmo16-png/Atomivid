/**
 * Ciclo de vida completo de una suscripción con el webhook REAL (`handleStripeWebhook`) y firmas REALES del SDK de Stripe
 * (`generateTestHeaderString`, sin red ni claves reales): alta → plan correcto → acceso → duplicado → renovación →
 * impago → recuperación → cancelación al final del periodo → baja → eventos fuera de orden, y los rechazos de firma
 * (alterada, caducada, secreto incorrecto). La tabla `subscriptions` se simula en memoria con la semántica que usa el
 * código (upsert por user_id y update por user_id + stripe_subscription_id). El acceso se decide con
 * `assertCanGenerate`, el mismo control que usa la generación de videos. NO prueba Stripe Live ni cobros reales.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { handleStripeWebhook, type WebhookDependencies } from "./webhook";
import { assertCanGenerate } from "./quota";
import { getPlanByPriceId } from "./plans";
import { buildCheckoutUrl } from "./checkout";
import { AlreadySubscribedError, classifyBillingError } from "./checkout-error";
import { blocksNewCheckout, isSubscriptionRecoverable } from "./subscription";

const SECRET = "whsec_lifecycle_local_only";
const USER = "0f0f0f0f-aaaa-4aaa-8aaa-000000000001";
const PRICES = { STRIPE_PRICE_ID_STARTER: "price_starter_test", STRIPE_PRICE_ID_PRO: "price_pro_test", STRIPE_PRICE_ID_BUSINESS: "price_business_test" };
Object.assign(process.env, PRICES);
const sdk = new Stripe("sk_test_local_only");

type Sub = { id: string; customer: string; status: string; cancel_at_period_end: boolean; metadata: Record<string, string>; items: { data: { current_period_end: number; price: { id: string } }[] } };
const sub = (over: Partial<Sub> & { price?: string; periodEnd?: number } = {}): Sub => ({
  id: over.id ?? "sub_1", customer: "cus_1", status: over.status ?? "active", cancel_at_period_end: over.cancel_at_period_end ?? false,
  metadata: { supabase_user_id: USER }, items: { data: [{ current_period_end: over.periodEnd ?? 1_800_000_000, price: { id: over.price ?? PRICES.STRIPE_PRICE_ID_PRO } }] },
});

function world() {
  const rows = new Map<string, Record<string, unknown>>(); // subscriptions por user_id
  const marketing = new Map<string, unknown>();
  let stripeState: Sub = sub(); // lo que Stripe devuelve HOY para subscriptions.retrieve
  const retrieved: string[] = [];
  const service = {
    from(table: string) {
      if (table === "marketing_events") return { upsert: async (v: { dedupe_key: string }) => { if (!marketing.has(v.dedupe_key)) marketing.set(v.dedupe_key, v); return { error: null }; } };
      if (table === "video_requests") {
        const chain: Record<string, unknown> = {};
        for (const k of ["select", "eq", "neq", "in", "or"]) chain[k] = () => chain;
        chain.then = (ok: (v: unknown) => void) => ok({ count: 0, error: null });
        return chain;
      }
      return {
        select: () => ({ eq: (_k: string, v: string) => ({ maybeSingle: async () => ({ data: table === "subscriptions" ? ([...rows.values()].find((r) => r.user_id === v || r.stripe_customer_id === v) ?? null) : null, error: null }) }) }),
        upsert: async (row: Record<string, unknown>) => { rows.set(String(row.user_id), { ...row }); return { error: null }; },
        update: (row: Record<string, unknown>) => ({ eq: (_a: string, userId: string) => ({ eq: async (_b: string, subId: string) => {
          const cur = rows.get(userId); if (cur && cur.stripe_subscription_id === subId) rows.set(userId, { ...cur, ...row }); return { error: null };
        } }) }),
      };
    },
  } as unknown as ReturnType<WebhookDependencies["service"]>;
  const deps: WebhookDependencies = {
    stripe: () => ({ webhooks: sdk.webhooks, subscriptions: { retrieve: async (id: string) => { retrieved.push(id); return { ...stripeState, id } as unknown as Stripe.Subscription; } } as unknown as Stripe["subscriptions"] }),
    service: () => service, webhookSecret: () => SECRET,
  };
  const send = async (type: string, object: unknown, opts: { secret?: string; timestamp?: number; tamper?: boolean } = {}) => {
    const payload = JSON.stringify({ id: `evt_${type}_${Math.random()}`, type, data: { object } });
    const header = sdk.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? SECRET, timestamp: opts.timestamp });
    const body = opts.tamper ? payload.replace(USER, "0f0f0f0f-bbbb-4bbb-8bbb-000000000002") : payload;
    return handleStripeWebhook(new Request("https://atomivid.test/api/stripe/webhook", { method: "POST", body, headers: { "stripe-signature": header } }), deps);
  };
  const can = async () => (await assertCanGenerate(service, USER, "visual", { id: USER, email: "cliente@example.test" })).allowed;
  return { rows, marketing, retrieved, send, can, setStripe: (s: Sub) => { stripeState = s; }, row: () => rows.get(USER) };
}

test("alta por Checkout: el webhook firmado activa el plan pagado (Pro) y da acceso a generar", async () => {
  const w = world();
  assert.equal(await w.can(), false, "sin suscripción no se genera");
  const r = await w.send("checkout.session.completed", { id: "cs_1", client_reference_id: USER, subscription: "sub_1", customer: "cus_1" });
  assert.equal(r.status, 200);
  assert.equal(w.row()?.status, "active");
  assert.equal(getPlanByPriceId(String(w.row()?.price_id))?.id, "pro");
  assert.equal(await w.can(), true);
  assert.equal(w.marketing.size, 1, "payment_confirmed medido una vez");
});

test("el mismo evento entregado dos veces no duplica filas ni la métrica de pago", async () => {
  const w = world();
  const ev = { id: "cs_1", client_reference_id: USER, subscription: "sub_1", customer: "cus_1" };
  await w.send("checkout.session.completed", ev); await w.send("checkout.session.completed", ev);
  await w.send("customer.subscription.created", sub());
  assert.equal(w.rows.size, 1); assert.equal(w.marketing.size, 1);
});

test("cada plan se resuelve por su Price ID; un precio desconocido cae a Starter, nunca a ilimitado", async () => {
  for (const [plan, price] of [["starter", PRICES.STRIPE_PRICE_ID_STARTER], ["pro", PRICES.STRIPE_PRICE_ID_PRO], ["business", PRICES.STRIPE_PRICE_ID_BUSINESS]] as const) {
    const w = world(); w.setStripe(sub({ price }));
    await w.send("customer.subscription.created", sub({ price }));
    assert.equal(getPlanByPriceId(String(w.row()?.price_id))?.id, plan);
  }
  assert.equal(getPlanByPriceId("price_desconocido"), null);
});

test("renovación: el nuevo fin de periodo se guarda y el acceso sigue", async () => {
  const w = world();
  await w.send("customer.subscription.created", sub());
  w.setStripe(sub({ periodEnd: 1_802_592_000 }));
  await w.send("customer.subscription.updated", sub({ periodEnd: 1_802_592_000 }));
  assert.equal(w.row()?.current_period_end, new Date(1_802_592_000 * 1000).toISOString());
  assert.equal(await w.can(), true);
});

test("impago → sin acceso, recuperable, sin segundo Checkout; al pagar se recupera el acceso", async () => {
  const w = world();
  await w.send("customer.subscription.created", sub());
  w.setStripe(sub({ status: "past_due" }));
  await w.send("customer.subscription.updated", sub({ status: "past_due" }));
  assert.equal(w.row()?.status, "past_due");
  assert.equal(await w.can(), false, "con pago pendiente no se generan videos");
  assert.equal(isSubscriptionRecoverable("past_due"), true);
  assert.equal(blocksNewCheckout("past_due"), true, "no se ofrece otro plan: se corrige el método de pago");
  w.setStripe(sub({ status: "active" }));
  await w.send("customer.subscription.updated", sub({ status: "active" }));
  assert.equal(await w.can(), true);
});

test("cancelación al final del periodo mantiene el acceso; la baja lo quita; un 'active' viejo no lo devuelve", async () => {
  const w = world();
  await w.send("customer.subscription.created", sub());
  w.setStripe(sub({ cancel_at_period_end: true }));
  await w.send("customer.subscription.updated", sub({ cancel_at_period_end: true }));
  assert.equal(w.row()?.cancel_at_period_end, true); assert.equal(await w.can(), true);
  w.setStripe(sub({ status: "canceled" }));
  await w.send("customer.subscription.deleted", sub({ status: "canceled" }));
  assert.equal(w.row()?.status, "canceled"); assert.equal(await w.can(), false);
  // Fuera de orden: llega tarde el 'created' original (snapshot 'active'). El webhook consulta el estado actual.
  await w.send("customer.subscription.created", sub({ status: "active" }));
  assert.equal(w.row()?.status, "canceled", "un evento viejo no reactiva una suscripción cancelada");
  assert.equal(await w.can(), false);
  assert.equal(blocksNewCheckout("canceled"), false, "tras la baja puede volver a suscribirse");
});

test("firma: cuerpo alterado, firma caducada (>5 min) y secreto incorrecto se rechazan sin escribir nada", async () => {
  const w = world();
  const ev = { id: "cs_1", client_reference_id: USER, subscription: "sub_1", customer: "cus_1" };
  assert.equal((await w.send("checkout.session.completed", ev, { tamper: true })).status, 400);
  assert.equal((await w.send("checkout.session.completed", ev, { timestamp: Math.floor(Date.now() / 1000) - 600 })).status, 400);
  assert.equal((await w.send("checkout.session.completed", ev, { secret: "whsec_atacante" })).status, 400);
  assert.equal(w.rows.size, 0); assert.equal(w.retrieved.length, 0, "ni siquiera se consulta a Stripe");
});

test("un Checkout completado sin cuenta asociada no activa a nadie", async () => {
  const w = world();
  const r = await w.send("checkout.session.completed", { id: "cs_2", client_reference_id: null, subscription: "sub_2", customer: "cus_2" });
  assert.equal(r.status, 200); assert.equal(w.rows.size, 0);
});

test("Checkout: con suscripción activa o con pago pendiente NO se crea otra (doble cobro); cancelada o nueva sí", async () => {
  let created = 0;
  const deps = (status: string | null) => ({
    createCheckoutSession: (async () => { created++; return { url: "https://checkout.stripe.test/s" }; }) as unknown as Parameters<typeof buildCheckoutUrl>[1]["createCheckoutSession"],
    getExistingCustomerId: async () => "cus_1", getExistingStatus: async () => status, priceId: "price_pro_test", siteUrl: "https://atomivid.test",
  });
  for (const status of ["active", "trialing", "past_due", "unpaid", "incomplete"]) {
    await assert.rejects(buildCheckoutUrl({ id: USER }, deps(status)), (e: unknown) => e instanceof AlreadySubscribedError && e.status === status);
  }
  assert.equal(created, 0, "Stripe nunca se llamó");
  assert.match(classifyBillingError(new AlreadySubscribedError("active")), /Ya tienes una suscripción activa.*No se te cobró nada/);
  assert.match(classifyBillingError(new AlreadySubscribedError("past_due")), /pago pendiente.*no abrimos un segundo cobro/);
  for (const status of [null, "canceled", "incomplete_expired"]) assert.equal(await buildCheckoutUrl({ id: USER }, deps(status)), "https://checkout.stripe.test/s");
  assert.equal(created, 3);
});
