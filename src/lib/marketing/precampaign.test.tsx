import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { FORBIDDEN_PRECAMPAIGN_CLAIMS, precampaignDemoUrl } from "./precampaign";
import { joinEarlyAccess } from "./early-access";
import PrecampaignPage from "@/app/lanzamiento/page";

const PAGE = readFileSync("src/app/lanzamiento/page.tsx", "utf8");
const ACTION = readFileSync("src/app/lanzamiento/actions.ts", "utf8");

function fakeDb() {
  const tables: Record<string, Record<string, unknown>[]> = { early_access_requests: [], marketing_events: [] };
  const from = (t: string) => ({
    select: () => ({ eq: (k1: string, v1: unknown) => ({ eq: (k2: string, v2: unknown) => ({
      maybeSingle: async () => ({ data: tables[t].find(r => r[k1] === v1 && r[k2] === v2) ?? null, error: null }) }) }) }),
    upsert: async (row: Record<string, unknown>) => { tables[t].push(row); return { error: null }; },
    insert: async (row: Record<string, unknown>) => {
      if (tables[t].some(r => r.dedupe_key === row.dedupe_key)) return { error: { code: "23505" } };
      tables[t].push(row); return { error: null };
    },
  });
  return { tables, from };
}
const ctx = { userId: null, visitorId: null, attribution: { source: "precampana", medium: null, campaign: null } };

async function render(params: Record<string, string> = {}, env?: string) {
  const prev = process.env.NEXT_PUBLIC_PRECAMPAIGN_DEMO_URL;
  if (env === undefined) delete process.env.NEXT_PUBLIC_PRECAMPAIGN_DEMO_URL; else process.env.NEXT_PUBLIC_PRECAMPAIGN_DEMO_URL = env;
  try { return renderToStaticMarkup(await PrecampaignPage({ searchParams: Promise.resolve(params) })); }
  finally { if (prev === undefined) delete process.env.NEXT_PUBLIC_PRECAMPAIGN_DEMO_URL; else process.env.NEXT_PUBLIC_PRECAMPAIGN_DEMO_URL = prev; }
}

test("lanzamiento: benefit, email, explicit consent and honeypot; no price, date, places or guarantees", async () => {
  const html = await render();
  assert.ok(html.includes("Tus ideas merecen convertirse en videos"));
  assert.ok(html.includes('name="email"') && html.includes('name="consent"') && html.includes('name="website"'));
  assert.ok(html.includes("No hay cobro ni fecha comprometida"));
  for (const re of FORBIDDEN_PRECAMPAIGN_CLAIMS) assert.ok(!re.test(html), `page must not claim ${re}`);
  assert.ok(!html.includes("<video"), "no demo until an approved URL is configured");
});

test("lanzamiento: confirmation replaces the form; a repeated email is acknowledged", async () => {
  assert.ok((await render({ registrado: "1" })).includes("Tu solicitud quedó registrada"));
  const again = await render({ registrado: "ya" });
  assert.ok(again.includes("ya estaba en la lista") && !again.includes('name="email"'));
  assert.ok((await render({ error: "Escribe un correo válido." })).includes("Escribe un correo válido."));
});

test("demo video only from an https URL configured by the owner", async () => {
  assert.equal(precampaignDemoUrl({}), null);
  assert.equal(precampaignDemoUrl({ NEXT_PUBLIC_PRECAMPAIGN_DEMO_URL: "http://x.test/a.mp4" }), null);
  assert.equal(precampaignDemoUrl({ NEXT_PUBLIC_PRECAMPAIGN_DEMO_URL: "https://u:p@x.test/a.mp4" }), null);
  assert.equal(precampaignDemoUrl({ NEXT_PUBLIC_PRECAMPAIGN_DEMO_URL: "nope" }), null);
  assert.equal(precampaignDemoUrl({ NEXT_PUBLIC_PRECAMPAIGN_DEMO_URL: " https://cdn.test/demo.mp4 " }), "https://cdn.test/demo.mp4");
  const html = await render({}, "https://cdn.test/demo.mp4");
  assert.ok(html.includes('<video src="https://cdn.test/demo.mp4"') && html.includes("Resultados de nuestras pruebas."));
});

test("same launch list as /avisame: 'reels' product, no new table, never charges; not linked from the landing", async () => {
  assert.match(ACTION, /joinEarlyAccess\(createServiceClient\(\), "reels"/);
  assert.match(ACTION, /redirect\(`\/lanzamiento\?registrado=/);
  assert.ok(!/stripe|checkout/i.test(PAGE + ACTION));
  assert.ok(!readFileSync("src/app/page.tsx", "utf8").includes('"/lanzamiento"'), "the landing does not advertise it yet");
  assert.match(PAGE, /robots: \{ index: false \}/);
  // Synthetic emails only: one row per email across /avisame and /lanzamiento, no email in events.
  const db = fakeDb();
  assert.deepEqual(await joinEarlyAccess(db as never, "reels", { email: "prueba@ejemplo.test", consent: "on", website: "" }, ctx), { ok: true, already: false });
  assert.deepEqual(await joinEarlyAccess(db as never, "reels", { email: "PRUEBA@ejemplo.test", consent: "on", website: "" }, ctx), { ok: true, already: true });
  assert.equal(db.tables.early_access_requests.length, 1);
  assert.ok(!JSON.stringify(db.tables.marketing_events).includes("prueba@"));
});
