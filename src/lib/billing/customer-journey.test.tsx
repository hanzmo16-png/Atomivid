/**
 * Recorrido de un cliente nuevo de Reels con proveedores SIMULADOS (sin red externa, sin Stripe real, USD 0):
 * registro → errores de Supabase Auth → enlace del correo → planes y Price IDs → Checkout → webhook → plan activo.
 * Nada de esto es una transacción real: Stripe y Supabase son dobles locales.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { humanizeAuthError } from "@/lib/auth/errors";
import { resolveSiteUrl } from "@/lib/http/site-url";
import { PLAN_ORDER, getPlanByPriceId, isPlanPurchasable, stripeMode } from "./plans";
import { salesOpen } from "./sales";
import { buildCheckoutUrl } from "./checkout";
import { handleStripeWebhook, type WebhookDependencies } from "./webhook";
import { PendingSubmitButton } from "@/components/ui/PendingSubmitButton";

const PRICES = { STRIPE_PRICE_ID_STARTER: "price_starter_sim", STRIPE_PRICE_ID_PRO: "price_pro_sim", STRIPE_PRICE_ID_BUSINESS: "price_business_sim" };

/** Supabase Auth (GoTrue) local que responde exactamente como respondió producción el 2026-10-09. */
async function fakeGoTrue(reply: { status: number; body: unknown }) {
  const seen: { path: string; redirectTo: string | null }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    seen.push({ path: url.pathname, redirectTo: url.searchParams.get("redirect_to") });
    req.resume();
    req.on("end", () => { res.writeHead(reply.status, { "content-type": "application/json" }); res.end(JSON.stringify(reply.body)); });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

test("reproducción del 9 de octubre: el 429 over_email_send_rate_limit de Supabase llega con código y se explica al cliente", async () => {
  const gotrue = await fakeGoTrue({ status: 429, body: { code: 429, error_code: "over_email_send_rate_limit", msg: "email rate limit exceeded" } });
  try {
    const supabase = createClient(gotrue.url, "anon-sim", { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await supabase.auth.signUp({ email: "cliente@correo.test", password: "secreto-123", options: { emailRedirectTo: "https://atomicvid.app/auth/callback" } });
    assert.equal(data.user, null, "la cuenta NO se crea cuando no se puede enviar el correo");
    assert.equal(error?.status, 429);
    assert.equal(error?.code, "over_email_send_rate_limit");
    const shown = humanizeAuthError(error?.message, error?.code);
    assert.match(shown, /No pudimos enviar el correo de confirmación/);
    assert.match(shown, /la cuenta no se creó/);
    assert.equal(gotrue.seen[0]?.path, "/auth/v1/signup");
    assert.equal(gotrue.seen[0]?.redirectTo, "https://atomicvid.app/auth/callback");
  } finally { await gotrue.close(); }
});

test("los errores de Auth se traducen por código estable aunque el texto en inglés cambie", () => {
  const cases: [string, RegExp][] = [
    ["over_email_send_rate_limit", /No pudimos enviar el correo/],
    ["email_address_invalid", /no es válido/],
    ["user_already_exists", /Ya existe una cuenta/],
    ["email_exists", /Ya existe una cuenta/],
    ["weak_password", /demasiado débil/],
    ["invalid_credentials", /incorrectos/],
    ["email_not_confirmed", /Confirma tu correo/],
    ["over_request_rate_limit", /Demasiados intentos/],
    ["signup_disabled", /registro de cuentas nuevas está cerrado/],
  ];
  for (const [code, expected] of cases) assert.match(humanizeAuthError("Some future wording v9", code), expected, code);
  // Sin código, sigue funcionando por texto; un código desconocido no expone nada crudo.
  assert.match(humanizeAuthError("email rate limit exceeded"), /No pudimos enviar el correo/);
  assert.doesNotMatch(humanizeAuthError("internal_xyz", "unknown_code_xyz"), /internal_xyz|unknown_code_xyz/);
});

test("el enlace del correo de confirmación nunca queda «null/auth/callback»", () => {
  assert.equal(resolveSiteUrl({}, null), "http://localhost:3000");
  assert.equal(resolveSiteUrl({}, "null"), "http://localhost:3000", "Origin opaco «null» se ignora");
  assert.equal(resolveSiteUrl({}, "https://atomicvid.app/"), "https://atomicvid.app");
  assert.equal(resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "https://atomicvid.app/" }, null), "https://atomicvid.app");
  assert.equal(resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "https://atomicvid.app" }, "https://otro.example"), "https://atomicvid.app", "la dirección configurada gana");
  assert.equal(resolveSiteUrl({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "atomivid-git-qa.vercel.app", NEXT_PUBLIC_SITE_URL: "https://atomicvid.app" }, null), "https://atomivid-git-qa.vercel.app", "una vista previa vuelve a sí misma");
  assert.equal(resolveSiteUrl({ VERCEL_ENV: "production", VERCEL_BRANCH_URL: "x.vercel.app", NEXT_PUBLIC_SITE_URL: "https://atomicvid.app" }, null), "https://atomicvid.app");
  const register = readFileSync("src/app/register/actions.ts", "utf8");
  assert.match(register, /resolveSiteUrl\(process\.env/);
  assert.match(register, /humanizeAuthError\(error\.message, error\.code\)/);
  assert.doesNotMatch(register, /\$\{origin\}\/auth\/callback/);
});

test("planes y Price IDs: cuándo se puede comprar cada plan (matriz de configuración)", () => {
  // Hoy en producción (sin Stripe): nada se vende y la portada invita a la lista de lanzamiento.
  assert.equal(salesOpen({ VERCEL_ENV: "production" }), false);
  // Producción con clave de PRUEBA: nunca se vende (tarjetas de prueba no pueden comprar producción real).
  assert.equal(salesOpen({ VERCEL_ENV: "production", STRIPE_SECRET_KEY: "sk_test_sim", ...PRICES }), false);
  // Producción con clave LIVE y precios: los tres planes se pueden comprar.
  const live = { VERCEL_ENV: "production", STRIPE_SECRET_KEY: "sk_live_sim", ...PRICES };
  assert.equal(stripeMode(live), "live");
  for (const id of PLAN_ORDER) assert.equal(isPlanPurchasable(id, live), true, id);
  // Solo un precio cargado: solo ese plan se vende; los otros muestran «Pagos aún no habilitados».
  const onlyStarter = { VERCEL_ENV: "production", STRIPE_SECRET_KEY: "rk_live_sim", STRIPE_PRICE_ID_STARTER: "price_starter_sim" };
  assert.deepEqual(PLAN_ORDER.map((id) => isPlanPurchasable(id, onlyStarter)), [true, false, false]);
  // Un Price ID con espacios (copiado del panel de Stripe) se acepta; uno vacío no.
  assert.equal(isPlanPurchasable("pro", { STRIPE_SECRET_KEY: "sk_test_sim", STRIPE_PRICE_ID_PRO: "  " }), false);
  // Vista previa con clave de prueba: entorno de ensayo de Stripe.
  assert.equal(salesOpen({ VERCEL_ENV: "preview", STRIPE_SECRET_KEY: "sk_test_sim", ...PRICES }), true);
});

test("checkout simulado → webhook firmado → la suscripción queda activa con el plan correcto (sin Stripe real)", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, PRICES);
  try {
    // 1) Checkout: parámetros exactos enviados a Stripe (doble local).
    let sent: Stripe.Checkout.SessionCreateParams | undefined;
    const url = await buildCheckoutUrl({ id: "user-nuevo", email: "cliente@correo.test" }, {
      createCheckoutSession: (async (params: Stripe.Checkout.SessionCreateParams) => { sent = params; return { url: "https://checkout.stripe.test/c/pay/cs_test_sim" }; }) as never,
      getExistingCustomerId: async () => null,
      priceId: process.env.STRIPE_PRICE_ID_PRO!,
      siteUrl: resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "https://atomicvid.app" }, null),
    });
    assert.equal(url, "https://checkout.stripe.test/c/pay/cs_test_sim");
    assert.equal(sent?.mode, "subscription");
    assert.deepEqual(sent?.line_items, [{ price: "price_pro_sim", quantity: 1 }]);
    assert.equal(sent?.client_reference_id, "user-nuevo");
    assert.equal(sent?.customer_email, "cliente@correo.test");
    assert.equal(sent?.subscription_data?.metadata?.supabase_user_id, "user-nuevo");
    assert.equal(sent?.success_url, "https://atomicvid.app/dashboard/billing?checkout=success");
    assert.equal(sent?.cancel_url, "https://atomicvid.app/dashboard/billing?checkout=canceled");

    // 2) Webhook checkout.session.completed firmado con un secreto local.
    const sdk = new Stripe("sk_test_local_only");
    const rows: Record<string, unknown>[] = [];
    const subscription = { id: "sub_sim", customer: "cus_sim", status: "active", metadata: { supabase_user_id: "user-nuevo" }, cancel_at_period_end: false,
      items: { data: [{ current_period_end: 1900000000, price: { id: "price_pro_sim" } }] } };
    const service = { from: (table: string) => table === "marketing_events"
      ? { upsert: async () => ({ error: null }) }
      : { upsert: async (row: Record<string, unknown>) => { rows.push(row); return { error: null }; } } } as unknown as ReturnType<WebhookDependencies["service"]>;
    const deps: WebhookDependencies = {
      stripe: () => ({ webhooks: sdk.webhooks, subscriptions: { retrieve: async () => subscription } as unknown as Stripe["subscriptions"] }),
      service: () => service,
      webhookSecret: () => "whsec_local_only",
    };
    const payload = JSON.stringify({ id: "evt_sim", type: "checkout.session.completed", data: { object: { client_reference_id: "user-nuevo", subscription: "sub_sim", customer: "cus_sim" } } });
    const signed = (secret: string) => new Request("https://atomicvid.test/api/stripe/webhook", { method: "POST", body: payload,
      headers: { "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload, secret }) } });

    const forged = await handleStripeWebhook(signed("whsec_otro"), deps);
    assert.equal(forged.status, 400, "un webhook con otra firma no activa nada");
    assert.equal(rows.length, 0);

    const ok = await handleStripeWebhook(signed("whsec_local_only"), deps);
    assert.equal(ok.status, 200);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, "user-nuevo");
    assert.equal(rows[0].status, "active");
    assert.equal(rows[0].price_id, "price_pro_sim");
    // 3) El price_id guardado resuelve el plan que el cliente eligió (cuota de Pro, no la de Starter).
    assert.equal(getPlanByPriceId(rows[0].price_id as string)?.id, "pro");

    // Sin secreto configurado el webhook se niega (no se activa una suscripción sin verificar).
    const unconfigured = await handleStripeWebhook(signed("whsec_local_only"), { ...deps, webhookSecret: () => undefined });
    assert.equal(unconfigured.status, 400);
  } finally {
    for (const k of Object.keys(PRICES)) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

test("los botones de registro, inicio de sesión y pago se bloquean mientras envían (sin doble alta ni doble Checkout)", () => {
  const idle = renderToStaticMarkup(<form><PendingSubmitButton pendingLabel="Creando tu cuenta…">Crear cuenta</PendingSubmitButton></form>);
  assert.match(idle, /<button[^>]*type="submit"[^>]*>Crear cuenta<\/button>/);
  assert.doesNotMatch(idle, /\sdisabled(=""|\s|>)|aria-busy/);
  const source = (p: string) => readFileSync(p, "utf8");
  assert.match(source("src/components/ui/PendingSubmitButton.tsx"), /useFormStatus\(\)[\s\S]*loading=\{pending\}/);
  assert.match(source("src/app/register/page.tsx"), /<PendingSubmitButton pendingLabel="Creando tu cuenta…">Crear cuenta<\/PendingSubmitButton>/);
  assert.match(source("src/app/login/page.tsx"), /<PendingSubmitButton pendingLabel="Entrando…">Iniciar sesión<\/PendingSubmitButton>/);
  const billing = source("src/app/dashboard/billing/page.tsx");
  assert.match(billing, /<PendingSubmitButton pendingLabel="Abriendo el pago seguro…">Elegir \{plan\.name\}<\/PendingSubmitButton>/);
  assert.match(billing, /Administrar suscripción<\/PendingSubmitButton>/);
  assert.doesNotMatch(billing, /<Button type="submit"/);
});

test("recuperar contraseña: botones bloqueados al enviar y enlace del correo con la misma regla que el registro", () => {
  const source = (p: string) => readFileSync(p, "utf8");
  assert.match(source("src/app/forgot-password/page.tsx"), /<PendingSubmitButton pendingLabel="Enviando el enlace…">Enviar enlace de recuperación<\/PendingSubmitButton>/);
  assert.match(source("src/app/reset-password/page.tsx"), /<PendingSubmitButton pendingLabel="Guardando…">Guardar nueva contraseña<\/PendingSubmitButton>/);
  const forgot = source("src/app/forgot-password/actions.ts");
  assert.match(forgot, /resolveSiteUrl\(process\.env, \(await headers\(\)\)\.get\("origin"\)\)/);
  assert.match(forgot, /redirectTo: `\$\{origin\}\/auth\/callback\?next=\/reset-password`/);
  assert.equal(`${resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "https://atomicvid.app" }, null)}/auth/callback?next=/reset-password`, "https://atomicvid.app/auth/callback?next=/reset-password");
});

test("facturación con pago pendiente: se ofrece «Actualizar método de pago», no un segundo plan", () => {
  const billing = readFileSync("src/app/dashboard/billing/page.tsx", "utf8");
  assert.match(billing, /\{recoverable && \([\s\S]*createPortalSession[\s\S]*Actualizar método de pago<\/PendingSubmitButton>/);
  assert.match(billing, /\{!active && !recoverable && \(/);
});
