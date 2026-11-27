import { test } from "node:test";
import assert from "node:assert/strict";
import { API_BALANCE_MAX_AGE_MS, balanceOf, readSentinelSnapshot, startOf, type SentinelDb } from "./read";
import { buildSentinelView, cardOf } from "./view";
import { SENTINEL_CONTRACT_VERSION, type SentinelBalance, type SentinelProvider } from "./contract";

const NOW = new Date("2026-11-27T15:00:00.000Z"); // 10:00 en Cancún (UTC−5)
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
const H = 3600_000; const MIN = 60_000;

type Tables = Record<string, Record<string, unknown>[] | "error">;
/** Base falsa de solo lectura: registra cada tabla/rpc consultada y falla si alguien intenta escribir. */
function fakeDb(tables: Tables, states: Record<string, unknown>) {
  const calls: string[] = [];
  const rows = (t: string) => { const v = tables[t]; return v === "error" ? { data: null, error: { message: "boom" } } : { data: v ?? [], error: null }; };
  const db = {
    from(t: string) {
      calls.push(`from:${t}`);
      return {
        select: () => ({
          neq: async () => rows(t),
          gte: (_c: string, v: unknown) => ({ order: () => ({ limit: async () => { const r = rows(t); return r.data ? { ...r, data: r.data.filter((x) => String(x.created_at) >= String(v)) } : r; } }) }),
          order: () => ({ limit: async () => rows(t) }),
        }),
        insert: () => { throw new Error("escritura prohibida"); }, update: () => { throw new Error("escritura prohibida"); }, delete: () => { throw new Error("escritura prohibida"); },
      };
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push(`rpc:${fn}:${args.p_provider}`);
      if (fn !== "pi_supply_state") throw new Error("rpc no permitido");
      const s = states[String(args.p_provider)];
      return s === "error" ? { data: null, error: { message: "x" } } : { data: s ?? null, error: null };
    },
  };
  return { db: db as unknown as SentinelDb, calls };
}

const pol = (provider: string, unit = "usd", enabled = true, daily = 5, monthly = 50) => ({ provider, enabled, unit, daily_cap_usd: daily, monthly_cap_usd: monthly, timezone: "America/Cancun" });
const op = (provider: string, hoursAgo: number, status: string, reserved: number, committed: number | null = null, extra: Record<string, unknown> = {}) =>
  ({ provider, method: "messages", status, reserved_usd: reserved, committed_usd: committed, supply_reconciled: false, created_at: iso(hoursAgo * H), ...extra });
const snap = (provider: string, available: number | null, reliability: string, agoMs: number, unit = "usd", health = "OK") => ({ provider, unit, available, health, reliability, checked_at: iso(agoMs) });

test("startOf: día y mes locales de Cancún en UTC", () => {
  assert.equal(startOf("day", NOW, "America/Cancun").toISOString(), "2026-11-27T05:00:00.000Z");
  assert.equal(startOf("month", NOW, "America/Cancun").toISOString(), "2026-11-01T05:00:00.000Z");
  assert.equal(startOf("day", new Date("2026-11-27T03:00:00Z"), "America/Cancun").toISOString(), "2026-11-26T05:00:00.000Z");
});

test("saldo: REAL solo con API de ≤ 5 min; más viejo = STALE; manual = ESTIMATED; sin fuente = UNKNOWN", () => {
  assert.equal(API_BALANCE_MAX_AGE_MS, 300_000);
  const real = balanceOf(snap("x", 40, "provider_api", 4 * MIN), NOW);
  assert.deepEqual([real.status, real.value, real.estimated, real.staleValue], ["REAL", 40, null, null]);
  const stale = balanceOf(snap("x", 40, "provider_api", 6 * MIN), NOW);
  assert.deepEqual([stale.status, stale.value, stale.staleValue], ["STALE", null, 40]);
  const manual = balanceOf(snap("x", 12, "manual_entry", 10 * 24 * H), NOW);
  assert.deepEqual([manual.status, manual.value, manual.estimated], ["ESTIMATED", null, 12]);
  for (const s of [snap("x", null, "provider_api", MIN), snap("x", 5, "none", MIN), snap("x", 5, "derived_from_ledger", MIN), snap("x", -1, "provider_api", MIN), snap("x", 5, "provider_api", -10 * MIN), null])
    assert.equal(balanceOf(s, NOW).status, "UNKNOWN");
});

test("lector: tablas reales, consumo por ventana, comprometido y semáforo del motor; nunca escribe", async () => {
  const { db, calls } = fakeDb({
    pi_supply_policies: [pol("anthropic"), pol("elevenlabs", "character", true, 3, 30), pol("heygen", "usd", false, 0, 0)],
    pi_capacity_snapshots: [
      snap("anthropic", 40, "provider_api", 2 * MIN), snap("anthropic", 99, "provider_api", 5 * H),
      snap("elevenlabs", 120000, "provider_api", 30 * MIN, "character"),
      snap("heygen", 12, "manual_entry", 10 * 24 * H, "usd", "DEGRADED"),
      snap("luma", null, "none", H, "usd", "UNCHECKED"),
    ],
    pi_paid_operations: [
      op("anthropic", 1, "COMMITTED", 0.5, 0.7), op("anthropic", 3, "SUBMITTED", 0.4), op("anthropic", 30, "COMMITTED", 1, 1), op("anthropic", 20 * 24, "COMMITTED", 2, 2),
      op("anthropic", 2, "RESERVED", 9), op("anthropic", 2, "REFUNDED", 9, null, { supply_reconciled: true }), op("anthropic", 2, "COMMITTED", 9, 9, { method: "capacity_hold" }),
    ],
    pi_supply_alerts: [{ provider: "anthropic", created_at: iso(H) }, { provider: "anthropic", created_at: iso(2 * H) }],
  }, {
    anthropic: { level: "YELLOW", reason: "YELLOW", free: 39.6, coverageHours: 60 },
    elevenlabs: { level: "UNKNOWN", reason: "balance unverified or stale", free: 1, coverageHours: 5 },
    heygen: "error",
  });
  const s = await readSentinelSnapshot(db, NOW);
  assert.equal(s.version, SENTINEL_CONTRACT_VERSION);
  assert.deepEqual(s.providers.map((p) => p.provider), ["anthropic", "elevenlabs", "heygen", "luma"]);
  const [a, e, h, l] = s.providers;
  assert.deepEqual(a.aliases, ["anthropic"]);
  assert.equal(a.balance.status, "REAL"); assert.equal(a.balance.value, 40);
  assert.deepEqual(a.consumptionUsd, { day: 0.7 + 0.4, week: 0.7 + 0.4 + 1, month: 0.7 + 0.4 + 1 + 2 });
  assert.equal(a.committedUsd, 0.4); assert.equal(a.openOperations, 1);
  assert.equal(a.level, "YELLOW"); assert.equal(a.free, 39.6); assert.deepEqual(a.autonomy, { days: 2.5, basis: "engine" });
  assert.equal(a.recentAlerts, 2); assert.deepEqual(a.limits, { dailyUsd: 5, monthlyUsd: 50, enabled: true });
  // API de hace 30 min: no vigente; el motor dice UNKNOWN → sin saldo libre ni cobertura (aunque el rpc traiga números).
  assert.equal(e.balance.status, "STALE"); assert.equal(e.balance.value, null); assert.equal(e.balance.staleValue, 120000);
  assert.equal(e.level, "UNKNOWN"); assert.equal(e.free, null); assert.equal(e.autonomy.days, null);
  // Manual de hace 10 días: estimado, no saldo real; el rpc falló → UNKNOWN y se informa.
  assert.equal(h.balance.status, "ESTIMATED"); assert.equal(h.balance.value, null); assert.equal(h.balance.estimated, 12);
  assert.equal(h.level, "UNKNOWN"); assert.deepEqual(h.limits, { dailyUsd: null, monthlyUsd: null, enabled: false });
  assert.ok(s.errors.includes("pi_supply_state heygen unavailable"));
  assert.equal(l.balance.status, "UNKNOWN"); assert.equal(l.limits, null); assert.equal(l.reason, "policy unconfigured");
  assert.ok(calls.every((c) => /^from:(pi_supply_policies|pi_capacity_snapshots|pi_paid_operations|pi_supply_alerts)$|^rpc:pi_supply_state:/.test(c)), calls.join("\n"));
  assert.ok(!calls.includes("rpc:pi_supply_state:luma"), "sin política no se consulta el estado");
});

test("fal.ai: FLUX y Recraft son UNA billetera — un saldo, consumo sumado, sin saldo libre ni autonomía combinados", async () => {
  const { db } = fakeDb({
    pi_supply_policies: [pol("flux", "usd", true, 2, 20), pol("recraft", "usd", true, 3, 30)],
    pi_capacity_snapshots: [snap("recraft", 25, "provider_api", MIN), snap("flux", 25, "provider_api", 2 * MIN), snap("flux", 90, "provider_api", 3 * H)],
    pi_paid_operations: [op("flux", 1, "COMMITTED", 0.2, 0.2), op("recraft", 2, "COMMITTED", 0.3, 0.3), op("recraft", 1, "SUBMITTED", 0.1)],
    pi_supply_alerts: [{ provider: "flux", created_at: iso(H) }],
  }, { flux: { level: "GREEN", reason: "GREEN", free: 24, coverageHours: 900 }, recraft: { level: "YELLOW", reason: "YELLOW", free: 24.9, coverageHours: 70 } });
  const s = await readSentinelSnapshot(db, NOW);
  assert.equal(s.providers.length, 1);
  const f = s.providers[0];
  assert.equal(f.provider, "fal"); assert.deepEqual(f.aliases, ["flux", "recraft"]);
  assert.equal(f.balance.value, 25, "un solo saldo (la lectura más reciente), nunca 50");
  assert.equal(f.level, "YELLOW", "el peor semáforo de los alias");
  assert.equal(f.free, null); assert.deepEqual(f.autonomy, { days: null, basis: null });
  assert.deepEqual(f.consumptionUsd, { day: 0.6, week: 0.6, month: 0.6 });
  assert.equal(f.committedUsd, 0.1); assert.equal(f.recentAlerts, 1);
  assert.deepEqual(f.limits, { dailyUsd: 5, monthlyUsd: 50, enabled: true });
  const c = cardOf(f, NOW.getTime(), "America/Cancun");
  assert.equal(c.name, "fal.ai"); assert.equal(c.sharedBy, "FLUX · Recraft"); assert.equal(c.autonomy.display, "Desconocida");
  assert.match(c.autonomy.note, /Billetera compartida/);
});

test("autonomía: la vista nunca la calcula; sin certificación del motor queda desconocida aunque haya saldo y consumo", async () => {
  const { db } = fakeDb({
    pi_supply_policies: [pol("anthropic")],
    pi_capacity_snapshots: [snap("anthropic", 14, "provider_api", MIN)],
    pi_paid_operations: [op("anthropic", 24, "COMMITTED", 7, 7), op("anthropic", 2, "SUBMITTED", 7)],
    pi_supply_alerts: [],
  }, { anthropic: { level: "UNKNOWN", reason: "policy unconfigured" } });
  const p = (await readSentinelSnapshot(db, NOW)).providers[0];
  assert.equal(p.balance.value, 14); assert.deepEqual(p.autonomy, { days: null, basis: null });
});

test("lector: sin políticas no inventa proveedores; fuentes caídas → desconocido, no 0", async () => {
  const down = await readSentinelSnapshot(fakeDb({ pi_supply_policies: "error" }, {}).db, NOW);
  assert.deepEqual(down.providers, []); assert.deepEqual(down.errors, ["pi_supply_policies unavailable"]);
  const partial = await readSentinelSnapshot(fakeDb({ pi_supply_policies: [pol("anthropic")], pi_capacity_snapshots: "error", pi_paid_operations: "error", pi_supply_alerts: "error" }, { anthropic: { level: "GREEN", reason: "GREEN", free: 10, coverageHours: null } }).db, NOW);
  const p = partial.providers[0];
  assert.equal(p.balance.status, "UNKNOWN"); assert.deepEqual(p.consumptionUsd, { day: null, week: null, month: null });
  assert.equal(p.committedUsd, null); assert.equal(p.recentAlerts, null); assert.equal(p.autonomy.days, null);
  assert.ok(partial.errors.includes("pi_paid_operations unavailable"));
});

const bal = (b: Partial<SentinelBalance>): SentinelBalance => ({ status: "UNKNOWN", value: null, estimated: null, staleValue: null, checkedAt: null, source: null, health: null, ...b });
const base: SentinelProvider = {
  provider: "anthropic", aliases: ["anthropic"], unit: "usd", balance: bal({ status: "REAL", value: 40, checkedAt: iso(2 * MIN), source: "provider_api", health: "OK" }),
  committedUsd: 0.4, openOperations: 1, free: 39.6, consumptionUsd: { day: 1.1, week: 2.1, month: 45 }, autonomy: { days: 2.5, basis: "engine" },
  level: "YELLOW", reason: "YELLOW", limits: { dailyUsd: 5, monthlyUsd: 50, enabled: true }, recentAlerts: 2,
};

test("vista: formato, semáforo, alertas preventivas y enlace directo a la consola", () => {
  const c = cardOf(base, NOW.getTime(), "America/Cancun");
  assert.equal(c.name, "Anthropic"); assert.equal(c.consoleUrl, "https://console.anthropic.com/settings/billing"); assert.equal(c.sharedBy, null);
  assert.equal(c.light.label, "Recargar pronto"); assert.equal(c.light.tone, "warn");
  assert.equal(c.balance.display, "40.00 USD"); assert.equal(c.balance.status, "REAL"); assert.match(c.balance.note, /Saldo real: API del proveedor hace 2 min/);
  assert.equal(c.committed, "0.40 USD · 1 operación abierta"); assert.equal(c.free, "39.60 USD");
  assert.deepEqual(c.consumption.map((x) => x.display), ["1.10 USD", "2.10 USD", "45.00 USD"]);
  assert.equal(c.autonomy.display, "2.5 días"); assert.equal(c.autonomy.tone, "danger"); assert.match(c.autonomy.note, /control de suministro/);
  const texts = c.alerts.map((a) => a.text).join("\n");
  assert.match(texts, /Recarga preventiva recomendada/); assert.match(texts, /Autonomía estimada de 2.5 días/);
  assert.match(texts, /Consumo del mes al 90 % del tope mensual/); assert.match(texts, /2 avisos del control/);
  assert.match(c.updated.display, /\(hace 2 min\)/);
  assert.equal(cardOf({ ...base, openOperations: 3 }, NOW.getTime(), "America/Cancun").committed, "0.40 USD · 3 operaciones abiertas");
});

test("vista: estimado ≈, no vigente y desconocido nunca se presentan como saldo real", () => {
  const est = cardOf({ ...base, balance: bal({ status: "ESTIMATED", estimated: 12, checkedAt: iso(3 * 24 * H), source: "manual_entry" }) }, NOW.getTime(), "America/Cancun");
  assert.equal(est.balance.display, "≈ 12.00 USD"); assert.match(est.balance.note, /no es un saldo leído de la API/);
  assert.ok(est.alerts.some((a) => /Saldo estimado/.test(a.text)));
  const stale = cardOf({ ...base, balance: bal({ status: "STALE", staleValue: 7, checkedAt: iso(30 * H), source: "provider_api" }) }, NOW.getTime(), "America/Cancun");
  assert.equal(stale.balance.display, "Desconocido"); assert.match(stale.balance.note, /hace 30 h \(7.00 USD\) ya no es vigente/);
  assert.ok(stale.alerts.some((a) => /menos de 5 minutos/.test(a.text)));
  const unknown: SentinelProvider = { ...base, provider: "nuevo", aliases: ["nuevo"], unit: null, balance: bal({}), committedUsd: null, openOperations: null, free: null, consumptionUsd: { day: null, week: null, month: null }, autonomy: { days: null, basis: null }, level: "UNKNOWN", reason: "policy unconfigured", limits: null, recentAlerts: null };
  const c = cardOf(unknown, NOW.getTime(), "America/Cancun");
  assert.equal(c.name, "nuevo"); assert.equal(c.consoleUrl, null);
  assert.equal(c.light.label, "Desconocido"); assert.equal(c.light.tone, "muted");
  assert.equal(c.balance.display, "Desconocido"); assert.match(c.balance.note, /Nunca se registró/);
  assert.equal(c.committed, "Desconocido"); assert.equal(c.free, "Desconocido");
  assert.deepEqual(c.consumption.map((x) => x.display), ["Desconocido", "Desconocido", "Desconocido"]);
  assert.equal(c.autonomy.display, "Desconocida");
  assert.ok(c.alerts.some((a) => /Saldo desconocido/.test(a.text)));
  assert.equal(c.updated.display, "Sin lecturas");
});

test("vista global: orden por urgencia, conteo del semáforo y estado vacío honesto", () => {
  const v = buildSentinelView({ version: SENTINEL_CONTRACT_VERSION, generatedAt: NOW.toISOString(), timezone: "America/Cancun", source: "existing-supply-tables", errors: [], providers: [
    { ...base, provider: "openai", aliases: ["openai"], level: "GREEN", reason: "GREEN", consumptionUsd: { day: 0.2, week: 1, month: 4 }, autonomy: { days: 40, basis: "engine" }, recentAlerts: 0 },
    { ...base, provider: "elevenlabs", aliases: ["elevenlabs"], level: "RED", reason: "RED" },
    { ...base },
  ] });
  assert.deepEqual(v.cards.map((c) => c.id), ["elevenlabs", "anthropic", "openai"]);
  assert.deepEqual(v.counts.map((c) => [c.level, c.count]), [["RED", 1], ["YELLOW", 1], ["UNKNOWN", 0], ["GREEN", 1]]);
  assert.equal(v.attention, 2); assert.equal(v.empty, null);
  assert.equal(v.cards[2].alerts.length, 0, "verde con 40 días y sin avisos: sin alertas");
  assert.match(buildSentinelView(null).empty ?? "", /No se autoriza gasto con datos desconocidos/);
  assert.match(buildSentinelView({ version: SENTINEL_CONTRACT_VERSION, generatedAt: NOW.toISOString(), timezone: "America/Cancun", source: "existing-supply-tables", errors: [], providers: [] }).empty ?? "", /Aún no hay proveedores/);
});
