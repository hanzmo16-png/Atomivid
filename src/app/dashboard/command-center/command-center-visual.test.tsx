/**
 * Command Center Visual V1 tests: renders the REAL view (react-dom/server) from the REAL
 * service over in-memory scenarios. No network, no database, no mock in app code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandCenterView } from "./CommandCenterView";
import { CommandCenterService } from "@/lib/command-center/service";
import { memorySource, type MemoryData } from "@/lib/command-center/sources";
import { buildViewModel } from "@/lib/command-center/view-model";
import { CommandCenterAccessError } from "@/lib/command-center/access";
import { RICH, EMPTY, MIGRATIONS_MISSING, PARTIAL, SERVICE_DOWN, NOW } from "@/lib/command-center/fixtures";
import type { WindowKey } from "@/lib/command-center/windows";

let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error("network forbidden in tests"); }) as typeof fetch;
const env = { AVATAR_PREPARATION_OWNER_EMAIL: "owner@atomivid.test" };
const owner = { id: "u-owner", email: "owner@atomivid.test", email_confirmed_at: NOW };
const normal = { id: "u-1", email: "user@example.com", email_confirmed_at: NOW };

async function render(d: MemoryData, o: { window?: WindowKey; youtubeConfigured?: boolean; user?: typeof owner } = {}) {
  const svc = new CommandCenterService({ source: memorySource(d), env, now: () => NOW });
  const overview = await svc.section(o.user ?? owner, "overview", o.window ?? "7D");
  const vm = buildViewModel({ data: overview.data as Parameters<typeof buildViewModel>[0]["data"], window: o.window ?? "7D", generatedAt: overview.generatedAt, youtubeConfigured: o.youtubeConfigured ?? false, pwaReady: true });
  return { vm, html: renderToStaticMarkup(<CommandCenterView vm={vm} />) };
}

test("admin can render the whole screen; normal user is denied by the service (403)", async () => {
  const { html } = await render(RICH, { youtubeConfigured: true });
  for (const s of ["Command Center", 'id="overview"', 'id="production"', 'id="costs"', 'id="providers"', 'id="youtube"', 'id="system-health"']) assert.ok(html.includes(s), s);
  await assert.rejects(render(RICH, { user: normal }), (e: CommandCenterAccessError) => e.status === 403);
});

test("mobile layout renders: 2-column tiles, horizontal window tabs, safe-area padding, touch-size targets", async () => {
  const { html } = await render(RICH);
  assert.ok(html.includes("grid-cols-2") && html.includes("sm:grid-cols-4"), "mobile-first grid");
  assert.ok(html.includes("overflow-x-auto") && html.includes('aria-label="Time window"'));
  assert.ok(html.includes("safe-area-inset-bottom"));
  assert.ok(html.includes("min-h-[92px]") && html.includes("px-4 py-2"), "tiles and tabs meet touch sizes");
  assert.ok(html.includes('aria-current="page"'));
  assert.ok(!html.includes("<table"), "no tables on mobile");
});

test("UNKNOWN is never rendered as zero; UNKNOWN provider is never HEALTHY; UNAVAILABLE revenue never shows $0", async () => {
  const { html, vm } = await render(RICH, { youtubeConfigured: true });
  const openai = vm.providers.cards.find((p) => p.provider === "OpenAI")!;
  assert.equal(openai.state, "UNKNOWN"); assert.equal(openai.balance, "Unavailable");
  assert.ok(html.includes('data-provider="OpenAI" data-state="UNKNOWN"') && !/data-provider="OpenAI" data-state="HEALTHY"/.test(html));
  assert.ok(html.includes("Provider balance unavailable"));
  assert.equal(vm.costs.revenue.state, "UNAVAILABLE"); assert.ok(html.includes("Stripe not connected") && !/Revenue \/ MRR[\s\S]{0,300}\$0/.test(html));
  const unknownTiles = vm.overview.filter((t) => t.state !== "KNOWN");
  for (const t of unknownTiles) assert.notEqual(t.display, "0");
  assert.equal(vm.overall.status, "Partial Data", "an UNKNOWN provider blocks Operational");
});

test("YouTube disconnected state: visible section, honest label, no chart, no zero views", async () => {
  const notConfigured = await render(PARTIAL, { youtubeConfigured: false });
  assert.equal(notConfigured.vm.youtube.setup, "NOT_CONFIGURED");
  assert.ok(notConfigured.html.includes("Not connected") && notConfigured.html.includes("Google OAuth configuration required"));
  const notConnected = await render(PARTIAL, { youtubeConfigured: true });
  assert.equal(notConnected.vm.youtube.setup, "NOT_CONNECTED");
  assert.ok(notConnected.html.includes("Read-only monitoring ready") && notConnected.html.includes("Connection required"));
  const ytViews = notConnected.vm.overview.find((t) => t.id === "yt-views")!;
  assert.equal(ytViews.state, "UNKNOWN"); assert.equal(ytViews.note, "YouTube not connected"); assert.notEqual(ytViews.display, "0");
  assert.ok(!notConnected.html.includes("<svg") && !notConnected.html.includes("<canvas"), "no chart without series");
  const connected = await render(RICH, { youtubeConfigured: true });
  assert.equal(connected.vm.youtube.setup, "CONNECTED"); assert.ok(connected.html.includes("1,240") && connected.html.includes("41.3%") && connected.html.includes("YT_SEARCH"));
});

test("migrations not applied: PI / Final Cut / YouTube report MIGRATION REQUIRED, never zeros; overall = Setup Required", async () => {
  const { html, vm } = await render(MIGRATIONS_MISSING);
  assert.equal(vm.overall.status, "Setup Required");
  assert.equal(vm.youtube.setup, "MIGRATION_REQUIRED"); assert.ok(html.includes("Migration required"));
  assert.equal(vm.production.finalCut, null); assert.ok(html.includes("Final Cut unavailable") && html.includes("0027"));
  assert.deepEqual(vm.providers.cards, []); assert.ok(html.includes("Provider capacity requires database migration"));
  assert.equal(vm.overview.find((t) => t.id === "fc-pending")!.state, "UNAVAILABLE");
  assert.equal(vm.overview.find((t) => t.id === "productions")!.display, "4", "core data still shown");
  assert.ok(html.includes('data-health="final-cut" data-state="NOT CONFIGURED"') && html.includes('data-health="youtube" data-state="NOT CONFIGURED"'));
});

test("empty database: real zeros are shown as zeros (KNOWN), nothing is UNAVAILABLE by mistake, status is Setup Required (YouTube not configured)", async () => {
  const { html, vm } = await render(EMPTY);
  assert.equal(vm.overview.find((t) => t.id === "productions")!.display, "0");
  assert.equal(vm.overview.find((t) => t.id === "users")!.state, "KNOWN");
  assert.equal(vm.overall.status, "Setup Required");
  assert.ok(html.includes("No capacity snapshot recorded yet"));
  const configured = await render(EMPTY, { youtubeConfigured: true });
  assert.equal(configured.vm.overall.status, "Partial Data", "configured but not connected is partial, not operational");
});

test("partial data: failed jobs and INSUFFICIENT provider -> Attention Required; provider INSUFFICIENT is distinct from HEALTHY and UNKNOWN", async () => {
  const { html, vm } = await render(PARTIAL, { youtubeConfigured: true });
  assert.equal(vm.overall.status, "Attention Required");
  assert.ok(vm.overall.reasons.some((r) => r.includes("insufficient")) && vm.overall.reasons.some((r) => r.includes("failed")));
  assert.ok(html.includes('data-provider="Runway" data-state="INSUFFICIENT"') && html.includes('data-provider="OpenAI" data-state="UNKNOWN"'));
  assert.ok(html.includes('data-health="providers" data-state="BLOCKED"'));
});

test("service unavailable: every section degrades honestly, nothing renders as 0, Database is BLOCKED", async () => {
  const { html, vm } = await render(SERVICE_DOWN);
  assert.ok(vm.overview.every((t) => t.state !== "KNOWN"), "no fabricated number");
  assert.ok(html.includes("Production data unavailable") && html.includes('data-health="database" data-state="BLOCKED"'));
  assert.equal(vm.overall.status, "Setup Required");
  assert.ok(!html.includes(">0<"), "no zero rendered anywhere");
});

test("Operational only when everything is KNOWN and no provider is UNKNOWN", async () => {
  const verified: MemoryData = { ...RICH, capacity: RICH.capacity!.map((c) => ({ ...c, available: c.available ?? 10, reliability: "provider_api" })) };
  const { vm } = await render(verified, { youtubeConfigured: true });
  assert.equal(vm.overall.status, "Operational");
  assert.equal((await render(RICH, { youtubeConfigured: true })).vm.overall.status, "Partial Data", "one UNKNOWN provider is enough to leave Operational");
});

test("time window tabs link to real windows and the selected one is marked", async () => {
  const { html } = await render(RICH, { window: "28D" });
  assert.ok(/<a[^>]*href="\/dashboard\/command-center\?window=28D"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/dashboard\/command-center\?window=28D"/.test(html));
  for (const w of ["TODAY", "7D", "MTD", "LIFETIME"]) assert.ok(html.includes(`?window=${w}"`));
});

test("sensitive admin responses stay no-store; page is force-dynamic and noindex", () => {
  const route = fs.readFileSync("src/app/api/admin/command-center/route.ts", "utf8");
  assert.ok(route.includes("private, no-store") && route.includes("force-dynamic"));
  const page = fs.readFileSync("src/app/dashboard/command-center/page.tsx", "utf8");
  assert.ok(page.includes('force-dynamic') && page.includes("index: false") && page.includes("isCommandCenterAdmin") && page.includes("notFound()"));
  assert.equal(networkCalls, 0);
});

test("expired provider evidence and missing registry entries stay visible as UNKNOWN in the actual panel", async () => {
  const { html, vm } = await render({ ...RICH, capacity: [{ ...RICH.capacity![0], checkedAt: "2026-10-29T18:00:00Z" }], capacityProviders: ["elevenlabs", "heygen"] }, { youtubeConfigured: true });
  assert.equal(vm.overall.status, "Partial Data");
  assert.ok(vm.providers.cards.every(p => p.state === "UNKNOWN" && p.balance === "Unavailable" && p.reserved === "Unavailable"));
  assert.ok(html.includes("Balance needs refresh")); assert.ok(html.includes("No capacity snapshot recorded yet"));
  assert.ok(!html.includes('data-state="HEALTHY"'));
});

test("an empty capacity source cannot claim providers READY even with YouTube connected", async () => {
  const { vm } = await render({ ...RICH, capacity: [] }, { youtubeConfigured: true });
  assert.equal(vm.overall.status, "Partial Data");
  assert.equal(vm.health.find(h => h.id === "providers")?.state, "UNKNOWN");
});

test("provider USD balances and reservations preserve cents", async () => {
  const { vm } = await render({ ...RICH, capacity: [{ ...RICH.capacity![0], provider: "openai", unit: "usd", available: 2.97, reserved: 0.15 }] });
  assert.equal(vm.providers.cards[0].balance, "2.97 USD");
  assert.equal(vm.providers.cards[0].reserved, "0.15 USD");
});
