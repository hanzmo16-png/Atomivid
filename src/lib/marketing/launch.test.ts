import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MARKETING_CTAS, attributionFromSearch, cleanToken, decodeAttribution, encodeAttribution, recordMarketingEvent, validVisitorId } from "./events";
import { EARLY_ACCESS_PRODUCTS, joinEarlyAccess, validateEarlyAccess } from "./early-access";
import { salesOpen } from "@/lib/billing/sales";
import { PLAN_CONFIGS, PLAN_ORDER, isPlanPurchasable, stripeMode } from "@/lib/billing/plans";

/** Minimal Supabase double: per-table rows, unique keys honoured on upsert(ignoreDuplicates). */
function fakeDb(opts: { failWrites?: boolean } = {}) {
  const tables: Record<string, Record<string, unknown>[]> = { marketing_events: [], early_access_requests: [] };
  return {
    tables,
    from(table: string) {
      const filters: [string, unknown][] = [];
      const chain = {
        select: () => chain,
        eq: (k: string, v: unknown) => { filters.push([k, v]); return chain; },
        maybeSingle: async () => ({ data: (tables[table] ?? []).find((r) => filters.every(([k, v]) => r[k] === v)) ?? null, error: null }),
        upsert: async (row: Record<string, unknown>, o: { onConflict: string }) => {
          if (opts.failWrites) return { error: { code: "08006" } };
          const keys = o.onConflict.split(",");
          if (!(tables[table] ?? []).some((r) => keys.every((k) => r[k] === row[k]))) tables[table].push(row);
          return { error: null };
        },
      };
      return chain;
    },
  };
}
const ctx = { userId: null, visitorId: "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90", attribution: { source: "newsletter", medium: null, campaign: null } };

test("campaign words are sanitized; unknown visitor ids are dropped", () => {
  assert.equal(cleanToken("Newsletter_Oct"), "newsletter_oct");
  assert.equal(cleanToken("<script>"), null);
  assert.equal(cleanToken("a".repeat(80))?.length, 64);
  assert.equal(validVisitorId("not-a-uuid"), null);
  const a = attributionFromSearch(new URLSearchParams("utm_source=YouTube&utm_medium=video&utm_campaign=launch%201"));
  assert.deepEqual(a, { source: "youtube", medium: "video", campaign: null });
  assert.deepEqual(decodeAttribution(encodeAttribution(a)), a);
});

test("events: one row per dedupe key, unknown events refused, a storage error never throws", async () => {
  const db = fakeDb();
  for (let i = 0; i < 3; i++) await recordMarketingEvent(db as never, { event: "landing_view", dedupeKey: "landing_view:v:2026-10-09", visitorId: ctx.visitorId });
  assert.equal(db.tables.marketing_events.length, 1, "a reload the same day counts once");
  assert.equal(await recordMarketingEvent(db as never, { event: "bogus" as never, dedupeKey: "x" }), false);
  assert.equal(await recordMarketingEvent(fakeDb({ failWrites: true }) as never, { event: "signup_completed", dedupeKey: "signup_completed:u" }), false);
  assert.ok(!JSON.stringify(db.tables.marketing_events).includes("@"), "no email in events");
});

test("early access: needs a valid email and consent; a bot is silently ignored; a repeat is not duplicated", async () => {
  assert.equal(validateEarlyAccess({ email: "x", consent: "on", website: "" }).ok, false);
  assert.equal(validateEarlyAccess({ email: "a@b.co", consent: null, website: "" }).ok, false);
  const db = fakeDb();
  assert.deepEqual(await joinEarlyAccess(db as never, "documentales", { email: "spam@bot.io", consent: "on", website: "http://spam" }, ctx), { ok: true, already: false });
  assert.equal(db.tables.early_access_requests.length, 0, "the honeypot stores nothing");
  assert.deepEqual(await joinEarlyAccess(db as never, "documentales", { email: " Ana@Correo.MX ", consent: "on", website: "" }, ctx), { ok: true, already: false });
  assert.deepEqual(await joinEarlyAccess(db as never, "documentales", { email: "ana@correo.mx", consent: "on", website: "" }, ctx), { ok: true, already: true });
  assert.equal(db.tables.early_access_requests.length, 1);
  assert.equal(db.tables.early_access_requests[0].email, "ana@correo.mx");
  assert.equal(db.tables.marketing_events.length, 1);
  assert.ok(!JSON.stringify(db.tables.marketing_events).includes("ana@"), "the event never carries the email");
});

test("a plan is purchasable only with its Stripe price AND the Stripe key", () => {
  assert.equal(isPlanPurchasable("starter", {}), false);
  assert.equal(isPlanPurchasable("starter", { STRIPE_PRICE_ID_STARTER: "price_x" }), false);
  assert.equal(isPlanPurchasable("starter", { STRIPE_PRICE_ID_STARTER: "price_x", STRIPE_SECRET_KEY: "sk_test_x" }), true);
});

test("the offer only lists what a customer can use: no avatar in plans, durations match the form", () => {
  for (const id of PLAN_ORDER) {
    const text = PLAN_CONFIGS[id].includes.join(" | ");
    assert.doesNotMatch(text, /avatar/i, id);
    assert.match(text, /30, 60 o 90 segundos/, id);
  }
  assert.deepEqual(PLAN_ORDER.map((id) => PLAN_CONFIGS[id].priceUsdPerMonth), [19, 49, 129], "prices unchanged");
});

test("landing copy: no free trial or speed promise; early access and 'Próximamente' are labelled as such", () => {
  const page = readFileSync("src/app/page.tsx", "utf8");
  for (const banned of [/cuenta gratis/i, /listo hoy/i, /en minutos/i, /sin excepciones/i, /ya es real y funcional/i]) assert.doesNotMatch(page, banned);
  assert.match(page, /Podcast Creator/);
  assert.match(page, /Próximamente/);
  assert.match(page, /Acceso anticipado/);
  assert.match(page, /No\. Crear la cuenta no tiene costo/);
});

test("sales gate: purchase CTAs only when a plan can be bought; otherwise the launch list", () => {
  assert.equal(salesOpen({} as Record<string, string | undefined>), false);
  assert.equal(salesOpen({ STRIPE_SECRET_KEY: "sk_test_x" }), false, "a key without prices does not open sales");
  assert.equal(salesOpen({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID_STARTER: "price_1" }), true);
  // Production never sells with a test key (test cards would buy real production); preview may.
  assert.equal(salesOpen({ VERCEL_ENV: "production", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID_STARTER: "price_1" }), false);
  assert.equal(salesOpen({ VERCEL_ENV: "preview", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID_STARTER: "price_1" }), true);
  assert.equal(salesOpen({ VERCEL_ENV: "production", STRIPE_SECRET_KEY: "sk_live_x", STRIPE_PRICE_ID_STARTER: "price_1" }), true);
  assert.equal(stripeMode({ STRIPE_SECRET_KEY: "rk_test_x" }), "test");
  assert.equal(stripeMode({}), "none");
  const page = readFileSync("src/app/page.tsx", "utf8");
  // Every register CTA on the landing sits behind salesOpen() with a launch-list alternative.
  const registerCtas = page.match(/href="\/register"/g) ?? [];
  const waitlistCtas = page.match(/href="\/avisame"/g) ?? [];
  assert.ok(registerCtas.length > 0);
  assert.equal(waitlistCtas.length, registerCtas.length, "one launch-list alternative per register CTA");
  assert.ok(EARLY_ACCESS_PRODUCTS.includes("reels"));
  for (const cta of ["header_waitlist", "hero_waitlist", "pricing_waitlist", "final_waitlist"] as const) assert.ok(MARKETING_CTAS.includes(cta));
});
