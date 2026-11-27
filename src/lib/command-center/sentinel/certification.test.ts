import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSentinelView, cardOf, explainReason } from "./view";
import { commandCenterSentinelSnapshot } from "@/lib/supply/command-center-source";
import type { SentinelProvider } from "./contract";
import { freshnessOf, STALE_AFTER_MS } from "@/app/dashboard/command-center/sentinel/SentinelFreshness";

const NOW = Date.parse("2026-11-27T15:00:00.000Z");
const base = (over: Partial<SentinelProvider> = {}): SentinelProvider => ({
  provider: "elevenlabs", aliases: ["elevenlabs"], unit: "usd",
  balance: { status: "REAL", value: 50, estimated: null, staleValue: null, checkedAt: new Date(NOW - 60_000).toISOString(), source: "provider_api", health: null },
  committedUsd: 0, openOperations: null, free: 50, consumptionUsd: { day: 0, week: 0, month: 0 }, autonomy: { days: 40, basis: "engine" },
  level: "GREEN", reason: "VERIFIED_LEDGER_ADJUSTMENT", limits: null, recentAlerts: null, ...over,
});

test("certificación: nunca verde si el saldo no es REAL, aunque el origen diga GREEN", () => {
  for (const balance of [
    { status: "UNKNOWN" as const, value: null, estimated: null, staleValue: null, checkedAt: null, source: null, health: null },
    { status: "STALE" as const, value: null, estimated: null, staleValue: 40, checkedAt: new Date(NOW - 3_600_000).toISOString(), source: "provider_api" as const, health: null },
    { status: "ESTIMATED" as const, value: null, estimated: 30, staleValue: null, checkedAt: new Date(NOW - 60_000).toISOString(), source: "manual_entry" as const, health: null },
  ]) {
    const c = cardOf(base({ balance }), NOW, "America/Cancun");
    assert.equal(c.light.level, "UNKNOWN", balance.status);
    assert.notEqual(c.light.tone, "ok");
    assert.match(c.light.explanation, /no se muestra en verde/);
  }
  assert.equal(cardOf(base(), NOW, "America/Cancun").light.level, "GREEN");
});

test("certificación: los códigos del motor se explican en español y los topes ausentes no se presentan como «sin política»", () => {
  const c = cardOf(base({ level: "UNKNOWN", reason: "CROSS_PRODUCT_LEDGER_COVERAGE_UNVERIFIED", free: null }), NOW, "America/Cancun");
  assert.match(c.light.explanation, /contabilidad propia/);
  assert.doesNotMatch(c.light.explanation, /CROSS_PRODUCT/);
  assert.doesNotMatch(c.limits, /Sin política/);
  assert.equal(c.free, "Desconocido");
  assert.equal(explainReason("UNRESOLVED_CHARGES"), "Hay cargos sin conciliar: el saldo libre no se puede certificar.");
});

test("certificación: con el adaptador real del motor, errores legibles y GRAY → Desconocido", () => {
  const account = { account: "fal", providers: ["flux", "recraft"], enabledProviders: ["flux"], unit: "usd", level: "GRAY", operationalLevel: "GRAY",
    available: null, estimatedAvailable: null, staleAvailable: 12, balanceStatus: "STALE", checkedAt: new Date(NOW - 7_200_000).toISOString(),
    held: 1.5, consumedSinceSnapshot: null, free: null, auditStatus: "BALANCE_UNVERIFIED_OR_STALE",
    consumption: { daily: { actualUsd: 0.2 }, rolling7d: { actualUsd: 1 }, monthly: { actualUsd: 3 } },
    forecast: { coverageDays: null }, topUpUrl: null };
  const snap = commandCenterSentinelSnapshot({ sentinel: { accounts: [account] } as never, observedAt: new Date(NOW).toISOString(), timezones: ["America/Cancun"] });
  const v = buildSentinelView(snap as never);
  assert.equal(v.cards[0].light.level, "UNKNOWN");
  assert.equal(v.cards[0].balance.display, "Desconocido");
  assert.equal(v.cards[0].sharedBy, "FLUX · Recraft");
  assert.ok(v.errors.every((e) => !/^[A-Z_]+$/.test(e)), v.errors.join("|"));
});

test("certificación: la lectura se marca desactualizada pasado el umbral y si la hora es inválida", () => {
  assert.deepEqual(freshnessOf(new Date(NOW - 60_000).toISOString(), NOW), { stale: false, minutes: 1 });
  assert.equal(freshnessOf(new Date(NOW - STALE_AFTER_MS - 1).toISOString(), NOW).stale, true);
  assert.deepEqual(freshnessOf("x", NOW), { stale: true, minutes: null });
});
