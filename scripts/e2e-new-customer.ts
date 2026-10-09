/**
 * New-customer verification against the deployed app, in a real browser, with an ordinary account
 * (no owner permissions). Zero provider spend: no script, voice or video is generated.
 *   1. Register through the real form; the address is confirmed with the admin API (the QA mailbox is
 *      not reachable), then the user signs in through the real login form.
 *   2. Dashboard as a non-subscriber: banner, Reel form only, no private beta entry points.
 *   3. Isolation: the owner's documentary, private pages and APIs answer "not found"/refused.
 *   4. Billing: plans shown; "Elegir" opens Stripe Checkout. The session id prefix tells test vs live mode.
 *      Live mode → STOP before any card is entered. Test mode → pay with Stripe's test card, then check that
 *      the webhook assigned the plan (subscriptions row + billing page) and the Reel form is usable.
 * Logs: statuses and booleans only (no emails, cookies or tokens).
 */
import { createClient } from "@supabase/supabase-js";
import { chromium, type Page } from "playwright";
import { randomUUID } from "node:crypto";

const APP = "https://atomivid.vercel.app";
const OWNER_REQUEST = "516b72ae-db4c-48a7-bea1-b08913c70a90"; // Hans's finished test documentary
const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
const results: { check: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { results.push({ check: name, ok, detail }); log(ok ? "PASS" : "FAIL", { check: name, detail }); };
const mode = (process.env.E2E_MODE ?? "verify").trim();

async function dismissTour(page: Page) {
  const skip = page.getByRole("button", { name: "Omitir" });
  if (await skip.isVisible({ timeout: 4000 }).catch(() => false)) await skip.click();
}
const bodyText = async (page: Page) => (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");

async function main() {
  const email = `qa.cliente.${Date.now()}@example.com`;
  const password = `Qa-${randomUUID()}`;
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  let userId: string | null = null;
  try {
    // 1. Register through the real form.
    await page.goto(`${APP}/register`, { waitUntil: "networkidle" });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await Promise.all([page.waitForURL(/\/login\?message=|\/register\?error=/, { timeout: 60000 }).catch(() => undefined), page.locator('form:has(input[name="email"]) button[type="submit"]').click()]);
    const after = new URL(page.url());
    check("register form → 'check your email' message", after.pathname === "/login" && (after.searchParams.get("message") ?? "").includes("correo"), { path: after.pathname, error: after.searchParams.get("error") });
    let created: { id: string; email_confirmed_at?: string | null } | undefined;
    for (let pageNo = 1; pageNo <= 10 && !created; pageNo++) {
      const { data: list } = await db.auth.admin.listUsers({ page: pageNo, perPage: 200 });
      created = list?.users.find((u) => u.email === email);
      if (!list?.users.length) break;
    }
    if (!created) { check("account exists after register", false); return; }
    userId = created.id;
    check("new account is unconfirmed until the email link", !created.email_confirmed_at);
    await db.auth.admin.updateUserById(userId, { email_confirm: true });

    // Sign in through the real login form.
    await page.goto(`${APP}/login`, { waitUntil: "networkidle" });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await Promise.all([page.waitForURL(/\/dashboard/, { timeout: 60000 }).catch(() => undefined), page.locator('form:has(input[name="email"]) button[type="submit"]').click()]);
    check("login → dashboard", new URL(page.url()).pathname.startsWith("/dashboard"), { path: new URL(page.url()).pathname });
    await dismissTour(page);

    // 2. Dashboard as a non-subscriber.
    const dash = await bodyText(page);
    check("non-subscriber sees that generating requires a subscription", /suscripción activa/i.test(dash));
    await page.goto(`${APP}/dashboard/new`, { waitUntil: "networkidle" });
    const create = await bodyText(page);
    check("new-video page offers the Reel form", (await page.locator('form input[name="topic"], form textarea[name="topic"]').count()) > 0);
    check("no YouTube/podcast/avatar entry points for an ordinary account", !/YouTube \/ Documental|Podcast \(Beta\)|avatar/i.test(create), { found: create.match(/YouTube \/ Documental|Podcast \(Beta\)|avatar/i)?.[0] ?? null });

    // 3. Isolation and private features.
    for (const path of [`/dashboard/videos/${OWNER_REQUEST}`, "/dashboard/long-form/new", "/dashboard/podcast", `/dashboard/long-form/configure/${OWNER_REQUEST}`]) {
      const r = await page.goto(`${APP}${path}`, { waitUntil: "domcontentloaded" });
      const status = r?.status() ?? 0;
      const text = await bodyText(page);
      check(`private page refused: ${path.replace(OWNER_REQUEST, "<owner-request>")}`, status === 404 || /no encontr|404|not found/i.test(text), { status });
    }
    for (const path of [`/api/generate/${OWNER_REQUEST}/render`, `/api/generate/${OWNER_REQUEST}/resume`, `/api/generate/${OWNER_REQUEST}/confirm-production`, "/api/podcast"]) {
      const status = await page.evaluate(async (p) => (await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, path);
      check(`private API refused: ${path.replace(OWNER_REQUEST, "<owner-request>")}`, [400, 401, 403, 404, 409].includes(status), { status });
    }
    const { data: ownerRow } = await db.from("video_requests").select("status,video_path").eq("id", OWNER_REQUEST).single();
    check("owner's documentary unchanged by the attempts", ownerRow?.status === "completed" && Boolean(ownerRow.video_path));

    // 4. Billing.
    await page.goto(`${APP}/dashboard/billing`, { waitUntil: "networkidle" });
    const billing = await bodyText(page);
    const plans = ["Starter", "Pro", "Business"].filter((p) => billing.includes(p));
    check("billing shows the current plans", plans.length === 3, { plans, prices: billing.match(/\$\s?\d+\s?\/mes/g) });
    const choose = page.getByRole("button", { name: /Elegir Starter/ });
    await Promise.all([page.waitForURL(/checkout\.stripe\.com|\/dashboard\/billing\?error/, { timeout: 60000 }).catch(() => undefined), choose.click()]);
    const checkoutUrl = page.url();
    const billingError = new URL(checkoutUrl).searchParams.get("error");
    const stripeMode = /cs_test_/.test(checkoutUrl) ? "test" : /cs_live_/.test(checkoutUrl) ? "live" : "unknown";
    check("'Elegir Starter' opens Stripe Checkout", /checkout\.stripe\.com/.test(checkoutUrl), { stripeMode, billingError });
    log("STRIPE_MODE", { mode: stripeMode });
    if (stripeMode !== "test" || mode !== "pay-test") {
      log("PAYMENT_NOT_ATTEMPTED", { reason: stripeMode === "live" ? "production Stripe is LIVE: no card entered, no charge" : stripeMode === "test" ? "test mode detected; payment step runs only in pay-test mode" : "no checkout session" });
      return;
    }
    // Stripe test mode only: Stripe's documented test card (no real money exists in test mode).
    await page.getByLabel(/Email/i).fill(email).catch(() => undefined);
    await page.getByPlaceholder(/1234 1234 1234 1234/).fill("4242424242424242");
    await page.getByPlaceholder(/MM \/ YY|MM \/ AA/).fill("12 / 34");
    await page.getByPlaceholder(/CVC/).fill("123");
    await page.getByPlaceholder(/Full name on card|Nombre/).fill("QA Atomivid").catch(() => undefined);
    await Promise.all([page.waitForURL(/\/dashboard\/billing\?checkout=success/, { timeout: 120000 }).catch(() => undefined), page.locator('button[type="submit"]').first().click()]);
    check("test payment returns to billing with success", /checkout=success/.test(page.url()));
    let sub: Record<string, any> | null = null;
    for (let i = 0; i < 20 && !(sub && ["active", "trialing"].includes(sub.status)); i++) {
      ({ data: sub } = await db.from("subscriptions").select("status,price_id").eq("user_id", userId).maybeSingle() as never);
      if (!(sub && ["active", "trialing"].includes(sub.status))) await new Promise((r) => setTimeout(r, 3000));
    }
    check("webhook assigned an active subscription", Boolean(sub && ["active", "trialing"].includes(sub.status)), { status: sub?.status ?? null });
    await page.goto(`${APP}/dashboard/billing`, { waitUntil: "networkidle" });
    check("billing shows the plan as active", /Administrar suscripción/.test(await bodyText(page)));
    await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    check("subscription banner gone", !/Necesitas una suscripción activa/i.test(await bodyText(page)));
  } finally {
    log("QA_ACCOUNT", { kept: Boolean(userId), note: "ordinary QA account (example.com), no owner permissions" });
    log("SUMMARY", { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.check) });
    await browser.close().catch(() => undefined);
  }
}

main().catch((e) => { console.error("E2E_FAILED", e instanceof Error ? e.message.slice(0, 300) : "error"); process.exitCode = 1; });
