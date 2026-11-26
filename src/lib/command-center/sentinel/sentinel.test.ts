import { test } from "node:test";
import assert from "node:assert/strict";
import { readSentinelSnapshot, startOf, type SentinelDb } from "./read";
import { buildSentinelView, cardOf } from "./view";
import { SENTINEL_CONTRACT_VERSION, type SentinelProvider } from "./contract";

const NOW = new Date("2026-11-27T15:00:00.000Z"); // 10:00 en Cancún (UTC−5)
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
const H = 3600_000;

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

const policies = [
  { provider: "anthropic", enabled: true, unit: "usd", daily_cap_usd: 5, monthly_cap_usd: 50, timezone: "America/Cancun" },
  { provider: "elevenlabs", enabled: true, unit: "character", daily_cap_usd: 3, monthly_cap_usd: 30, timezone: "America/Cancun" },
  { provider: "heygen", enabled: false, unit: "usd", daily_cap_usd: 0, monthly_cap_usd: 0, timezone: "America/Cancun" },
];
const op = (provider: string, hoursAgo: number, status: string, reserved: number, committed: number | null = null, extra: Record<string, unknown> = {}) =>
  ({ provider, method: "messages", status, reserved_usd: reserved, committed_usd: committed, supply_reconciled: false, created_at: iso(hoursAgo * H), ...extra });

test("startOf: día y mes locales de Cancún en UTC", () => {
  assert.equal(startOf("day", NOW, "America/Cancun").toISOString(), "2026-11-27T05:00:00.000Z");
  assert.equal(startOf("month", NOW, "America/Cancun").toISOString(), "2026-11-01T05:00:00.000Z");
  assert.equal(startOf("day", new Date("2026-11-27T03:00:00Z"), "America/Cancun").toISOString(), "2026-11-26T05:00:00.000Z");
});

test("lector: datos reales de las tablas, consumo por ventana, comprometido y semáforo del motor; nunca escribe", async () => {
  const { db, calls } = fakeDb({
    pi_supply_policies: policies,
    pi_capacity_snapshots: [
      { provider: "anthropic", unit: "usd", available: 40, health: "OK", reliability: "provider_api", checked_at: iso(2 * 60_000) },
      { provider: "anthropic", unit: "usd", available: 99, health: "OK", reliability: "provider_api", checked_at: iso(5 * H) },
      { provider: "elevenlabs", unit: "character", available: 120000, health: "OK", reliability: "provider_api", checked_at: iso(30 * H) },
      { provider: "heygen", unit: "usd", available: 12, health: "DEGRADED", reliability: "manual_entry", checked_at: iso(10 * 24 * H) },
      { provider: "luma", unit: "usd", available: null, health: "UNCHECKED", reliability: "none", checked_at: iso(H) },
    ],
    pi_paid_operations: [
      op("anthropic", 1, "COMMITTED", 0.5, 0.7),          // hoy
      op("anthropic", 3, "SUBMITTED", 0.4),                // hoy y abierto
      op("anthropic", 30, "COMMITTED", 1, 1),              // 7 días y mes
      op("anthropic", 20 * 24, "COMMITTED", 2, 2),         // mes (fuera de 7 días)
      op("anthropic", 2, "RESERVED", 9),                   // no cuenta: reserva sin enviar
      op("anthropic", 2, "REFUNDED", 9, null, { supply_reconciled: true }), // no cuenta: reembolso conciliado
      op("anthropic", 2, "COMMITTED", 9, 9, { method: "capacity_hold" }),   // no cuenta: retención de capacidad
    ],
    pi_supply_alerts: [{ provider: "anthropic", created_at: iso(H) }, { provider: "anthropic", created_at: iso(2 * H) }],
  }, {
    anthropic: { level: "YELLOW", reason: "YELLOW", free: 39.6, coverageHours: 60 },
    elevenlabs: { level: "UNKNOWN", reason: "balance unverified or stale", free: 1, coverageHours: 5 },
    heygen: "error",
  });
  const s = await readSentinelSnapshot(db, NOW);
  assert.equal(s.version, SENTINEL_CONTRACT_VERSION);
  assert.equal(s.timezone, "America/Cancun");
  assert.deepEqual(s.providers.map((p) => p.provider), ["anthropic", "elevenlabs", "heygen", "luma"]);
  const [a, e, h, l] = s.providers;
  assert.equal(a.balance.value, 40); assert.equal(a.balance.source, "provider_api"); // la lectura más reciente
  assert.deepEqual(a.consumptionUsd, { day: 0.7 + 0.4, week: 0.7 + 0.4 + 1, month: 0.7 + 0.4 + 1 + 2 });
  assert.equal(a.committedUsd, 0.4); assert.equal(a.openOperations, 1);
  assert.equal(a.level, "YELLOW"); assert.equal(a.free, 39.6); assert.deepEqual(a.autonomy, { days: 2.5, basis: "engine" });
  assert.equal(a.recentAlerts, 2);
  assert.deepEqual(a.limits, { dailyUsd: 5, monthlyUsd: 50, enabled: true });
  // API de hace 30 h: no vigente → saldo desconocido; el motor dice UNKNOWN → sin saldo libre ni cobertura inventados.
  assert.equal(e.balance.value, null); assert.equal(e.balance.stale, true); assert.equal(e.level, "UNKNOWN"); assert.equal(e.free, null); assert.equal(e.autonomy.days, null);
  // Registro manual: persiste (política existente) aunque tenga 10 días; el rpc falló → UNKNOWN y se informa.
  assert.equal(h.balance.value, 12); assert.equal(h.balance.source, "manual_entry"); assert.equal(h.level, "UNKNOWN");
  assert.deepEqual(h.limits, { dailyUsd: null, monthlyUsd: null, enabled: false });
  assert.ok(s.errors.includes("pi_supply_state heygen unavailable"));
  // Proveedor sin política: solo aparece por su lectura; reliability none → desconocido.
  assert.equal(l.balance.value, null); assert.equal(l.balance.stale, false); assert.equal(l.limits, null); assert.equal(l.reason, "policy unconfigured");
  // Solo lecturas: tablas y la función de estado; nada más.
  assert.ok(calls.every((c) => /^from:(pi_supply_policies|pi_capacity_snapshots|pi_paid_operations|pi_supply_alerts)$|^rpc:pi_supply_state:/.test(c)), calls.join("\n"));
  assert.ok(!calls.includes("rpc:pi_supply_state:luma"), "sin política no se consulta el estado");
});

test("lector: sin políticas no inventa proveedores; fuentes caídas → desconocido, no 0", async () => {
  const down = await readSentinelSnapshot(fakeDb({ pi_supply_policies: "error" }, {}).db, NOW);
  assert.deepEqual(down.providers, []); assert.deepEqual(down.errors, ["pi_supply_policies unavailable"]);
  const partial = await readSentinelSnapshot(fakeDb({ pi_supply_policies: policies.slice(0, 1), pi_capacity_snapshots: "error", pi_paid_operations: "error", pi_supply_alerts: "error" }, { anthropic: { level: "GREEN", reason: "GREEN", free: 10, coverageHours: null } }).db, NOW);
  const p = partial.providers[0];
  assert.equal(p.balance.value, null); assert.deepEqual(p.consumptionUsd, { day: null, week: null, month: null });
  assert.equal(p.committedUsd, null); assert.equal(p.recentAlerts, null); assert.equal(p.autonomy.days, null);
  assert.ok(partial.errors.includes("pi_paid_operations unavailable"));
});

test("autonomía de respaldo: solo con saldo USD vigente y consumo real de 7 días", async () => {
  const { db } = fakeDb({
    pi_supply_policies: [{ provider: "anthropic", enabled: true, unit: "usd", daily_cap_usd: 5, monthly_cap_usd: 50, timezone: "America/Cancun" }],
    pi_capacity_snapshots: [{ provider: "anthropic", unit: "usd", available: 14, health: "OK", reliability: "provider_api", checked_at: iso(H) }],
    pi_paid_operations: [op("anthropic", 24, "COMMITTED", 7, 7), op("anthropic", 2, "SUBMITTED", 7)],
    pi_supply_alerts: [],
  }, { anthropic: { level: "UNKNOWN", reason: "balance unverified or stale" } });
  const p = (await readSentinelSnapshot(db, NOW)).providers[0];
  // (14 − 7 comprometido) ÷ (14 USD / 7 días) = 3.5 días
  assert.deepEqual(p.autonomy, { days: 3.5, basis: "avg7d" });
});

const base: SentinelProvider = {
  provider: "anthropic", unit: "usd", balance: { value: 40, checkedAt: iso(2 * 60_000), source: "provider_api", stale: false, health: "OK" },
  committedUsd: 0.4, openOperations: 1, free: 39.6, consumptionUsd: { day: 1.1, week: 2.1, month: 45 }, autonomy: { days: 2.5, basis: "engine" },
  level: "YELLOW", reason: "YELLOW", limits: { dailyUsd: 5, monthlyUsd: 50, enabled: true }, recentAlerts: 2,
};

test("vista: formato, semáforo, alertas preventivas y enlace directo a la consola", () => {
  const c = cardOf(base, NOW.getTime(), "America/Cancun");
  assert.equal(c.name, "Anthropic"); assert.equal(c.consoleUrl, "https://console.anthropic.com/settings/billing");
  assert.equal(c.light.label, "Recargar pronto"); assert.equal(c.light.tone, "warn");
  assert.equal(c.balance.display, "40.00 USD"); assert.match(c.balance.note, /API del proveedor hace 2 min/);
  assert.equal(c.committed, "0.40 USD · 1 operación abierta"); assert.equal(c.free, "39.60 USD");
  assert.deepEqual(c.consumption.map((x) => x.display), ["1.10 USD", "2.10 USD", "45.00 USD"]);
  assert.equal(c.autonomy.display, "2.5 días"); assert.equal(c.autonomy.tone, "danger");
  const texts = c.alerts.map((a) => a.text).join("\n");
  assert.match(texts, /Recarga preventiva recomendada/); assert.match(texts, /Autonomía estimada de 2.5 días/);
  assert.match(texts, /Consumo del mes al 90 % del tope mensual/); assert.match(texts, /2 avisos del control/);
  assert.match(c.updated.display, /\(hace 2 min\)/);
  assert.equal(cardOf({ ...base, openOperations: 3 }, NOW.getTime(), "America/Cancun").committed, "0.40 USD · 3 operaciones abiertas");
});

test("vista: lo desconocido se escribe «Desconocido», nunca 0 ni verde", () => {
  const unknown: SentinelProvider = { ...base, provider: "nuevo", unit: null, balance: { value: null, checkedAt: null, source: null, stale: false, health: null }, committedUsd: null, openOperations: null, free: null, consumptionUsd: { day: null, week: null, month: null }, autonomy: { days: null, basis: null }, level: "UNKNOWN", reason: "policy unconfigured", limits: null, recentAlerts: null };
  const c = cardOf(unknown, NOW.getTime(), "America/Cancun");
  assert.equal(c.name, "nuevo"); assert.equal(c.consoleUrl, null);
  assert.equal(c.light.label, "Desconocido"); assert.equal(c.light.tone, "muted");
  assert.equal(c.balance.display, "Desconocido"); assert.match(c.balance.note, /Nunca se registró/);
  assert.equal(c.committed, "Desconocido"); assert.equal(c.free, "Desconocido");
  assert.deepEqual(c.consumption.map((x) => x.display), ["Desconocido", "Desconocido", "Desconocido"]);
  assert.equal(c.autonomy.display, "Desconocida");
  assert.ok(c.alerts.some((a) => /Saldo desconocido/.test(a.text)));
  assert.equal(c.updated.display, "Sin lecturas");
  const stale = cardOf({ ...unknown, balance: { value: null, checkedAt: iso(30 * H), source: "provider_api", stale: true, health: "OK" } }, NOW.getTime(), "America/Cancun");
  assert.match(stale.balance.note, /hace 30 h\) ya no es vigente/);
});

test("vista global: orden por urgencia, conteo del semáforo y estado vacío honesto", () => {
  const v = buildSentinelView({ version: SENTINEL_CONTRACT_VERSION, generatedAt: NOW.toISOString(), timezone: "America/Cancun", source: "existing-supply-tables", errors: [], providers: [
    { ...base, provider: "openai", level: "GREEN", reason: "GREEN", consumptionUsd: { day: 0.2, week: 1, month: 4 }, autonomy: { days: 40, basis: "engine" }, recentAlerts: 0 },
    { ...base, provider: "elevenlabs", level: "RED", reason: "RED" },
    { ...base, provider: "anthropic" },
  ] });
  assert.deepEqual(v.cards.map((c) => c.id), ["elevenlabs", "anthropic", "openai"]);
  assert.deepEqual(v.counts.map((c) => [c.level, c.count]), [["RED", 1], ["YELLOW", 1], ["UNKNOWN", 0], ["GREEN", 1]]);
  assert.equal(v.attention, 2); assert.equal(v.empty, null);
  assert.equal(v.cards[2].alerts.length, 0, "verde con 40 días y sin avisos: sin alertas");
  assert.match(buildSentinelView(null).empty ?? "", /No se autoriza gasto con datos desconocidos/);
  assert.match(buildSentinelView({ version: SENTINEL_CONTRACT_VERSION, generatedAt: NOW.toISOString(), timezone: "America/Cancun", source: "existing-supply-tables", errors: [], providers: [] }).empty ?? "", /Aún no hay proveedores/);
});
