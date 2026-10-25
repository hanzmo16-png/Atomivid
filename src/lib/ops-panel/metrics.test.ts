// Pruebas con datos SINTÉTICOS (datos de ejemplo): ninguna cifra es real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRow, computeOpsMetrics, formatUnits, toUnits, OpsMetricsError, type LedgerRow, type OpsInput } from "./metrics";
import { SYNTHETIC_INPUT } from "./fixture";

const base = (ledger: LedgerRow[], extra: Partial<OpsInput> = {}): OpsInput => ({
  source: { kind: "synthetic", label: "SINTÉTICO · prueba", asOf: "2026-10-24T00:00:00Z" },
  period: { fromIso: "2026-10-01T00:00:00Z", toIso: "2026-11-01T00:00:00Z" },
  dayStartIso: "2026-10-24T00:00:00Z", monthStartIso: "2026-10-01T00:00:00Z", ledger, ...extra,
});
const op = (status: string, reservedUsd: string | number, committedUsd: string | number | null = null, over: Partial<LedgerRow> = {}): LedgerRow =>
  ({ origin: "synthetic", projectId: "sintetico-p1", provider: "openai", method: "IMAGE", status, reservedUsd, committedUsd, supplyReconciled: false, createdAt: "2026-10-24T10:00:00Z", ...over });

test("decimal exacto: 0.1 + 0.2 suma 0.3000 sin deriva de coma flotante", () => {
  const m = computeOpsMetrics(base([op("COMMITTED", "0.1", "0.1"), op("COMMITTED", "0.2", "0.2")]));
  assert.equal(m.totals.committedUsd, "0.3000");
  assert.equal(formatUnits(toUnits("0.0001") * BigInt(3)), "0.0003");
  assert.equal(formatUnits(BigInt(-12345)), "-1.2345");
  // 10 000 × 0.0001 en coma flotante deriva; aquí es exactamente 1.0000.
  const many = Array.from({ length: 10_000 }, () => op("COMMITTED", "0.0001", "0.0001"));
  assert.equal(computeOpsMetrics(base(many)).totals.committedUsd, "1.0000");
});

test("importes inválidos fallan cerrado: negativos, NaN, >4 decimales, exponentes y desbordamiento de numeric(12,4)", () => {
  for (const bad of ["-1", "abc", "0.00001", "1e5", "100000000.0000", Number.NaN, Number.POSITIVE_INFINITY, 0.1 + 0.2])
    assert.throws(() => toUnits(bad as string | number), OpsMetricsError, String(bad));
  assert.equal(toUnits("99999999.9999"), BigInt("999999999999"));
  assert.equal(toUnits(12.5), BigInt(125000));
  assert.throws(() => computeOpsMetrics(base([op("COMMITTED", "1", "-0.5")])), /INVALID_AMOUNT/);
  assert.throws(() => computeOpsMetrics(base([op("COMMITTED", "1", "1", { createdAt: "ayer" })])), /INVALID_DATE/);
});

test("RESERVED nunca es gasto; SUBMITTED/PJR/RR son inciertos; COMMITTED usa committed_usd o la reserva", () => {
  const m = computeOpsMetrics(base([
    op("RESERVED", "5.0000"), op("SUBMITTED", "0.5000"), op("PROVIDER_JOB_RECORDED", "0.2500"),
    op("RECONCILIATION_REQUIRED", "1.0000"), op("COMMITTED", "0.3000", "0.1234"), op("COMMITTED", "0.4000", null),
  ]));
  assert.equal(m.totals.committedUsd, "0.5234");
  assert.equal(m.totals.uncertainUsd, "1.7500");
  assert.equal(m.totals.reservedNotSpentUsd, "5.0000");
  assert.equal(m.totals.committedWithoutAmount, 1);
  assert.deepEqual([m.totals.committedOps, m.totals.uncertainOps, m.totals.reservedOps], [2, 3, 1]);
  assert.equal(m.activity.activeProviderCalls, 2);
  assert.equal(m.activity.reconciliationRequired, 1);
});

test("REFUNDED conciliado libera (0); REFUNDED sin conciliar sigue incierto", () => {
  assert.equal(classifyRow(op("REFUNDED", "2", "0", { supplyReconciled: true })).cls, "released");
  const m = computeOpsMetrics(base([op("REFUNDED", "2.0000", "0", { supplyReconciled: true }), op("REFUNDED", "0.7000", null)]));
  assert.equal(m.totals.committedUsd, "0.0000");
  assert.equal(m.totals.uncertainUsd, "0.7000");
  assert.equal(m.totals.releasedOps, 1);
  assert.equal(m.activity.refundsUnreconciled, 1);
});

test("capacity_hold se excluye y un estado desconocido cuenta como incierto (fail-closed)", () => {
  const m = computeOpsMetrics(base([op("RESERVED", "9", null, { method: "capacity_hold" }), op("COMMITTED", "9", "9", { method: "capacity_hold" }), op("RARO", "0.1000")]));
  assert.equal(m.totals.excludedOps, 2);
  assert.equal(m.totals.committedUsd, "0.0000");
  assert.equal(m.totals.uncertainUsd, "0.1000");
  assert.equal(m.totals.unknownStatusOps, 1);
});

test("cero datos: totales en cero, sin fuente de trabajos/topes/precio (no se inventan)", () => {
  const m = computeOpsMetrics(base([]));
  assert.equal(m.totals.ops, 0);
  assert.equal(m.totals.committedUsd, "0.0000");
  assert.deepEqual(m.byProvider, []);
  assert.equal(m.activity.jobs.state, "NO_SOURCE");
  assert.equal(m.headroom.state, "NO_SOURCE");
  assert.equal(m.margins.state, "NO_PRICE_SOURCE");
  assert.equal(computeOpsMetrics(base([], { jobs: [], prices: [] })).activity.jobs.state, "KNOWN");
});

test("nunca mezcla fuentes: una fila real en una vista sintética (o al revés) se rechaza", () => {
  assert.throws(() => computeOpsMetrics(base([op("COMMITTED", "1", "1", { origin: "real" })])), /MIXED_DATA_SOURCES/);
  assert.throws(() => computeOpsMetrics({ ...base([]), source: { kind: "real", label: "x", asOf: "2026-10-24T00:00:00Z" }, prices: [{ origin: "synthetic", projectId: "p", priceUsd: "1", basis: "x" }] }), /MIXED_DATA_SOURCES/);
});

test("periodo: solo cuenta filas dentro de [from, to); los topes usan día/mes por fecha de creación", () => {
  const m = computeOpsMetrics(base([op("COMMITTED", "1", "1", { createdAt: "2026-09-30T23:59:59Z" }), op("COMMITTED", "2", "2", { createdAt: "2026-11-01T00:00:00Z" }), op("COMMITTED", "3", "3")],
    { providerCaps: [{ origin: "synthetic", provider: "openai", dailyCapUsd: "10", monthlyCapUsd: "4", enabled: true }] }));
  assert.equal(m.totals.committedUsd, "3.0000");
  const h = m.headroom.state === "KNOWN" ? m.headroom.providers[0] : null;
  assert.ok(h);
  // Como pi_supply_state: desde el inicio del día/mes, sin cota superior (la fila del 1 de nov también cuenta).
  assert.equal(h.daily.usedUsd, "5.0000"); assert.equal(h.daily.headroomUsd, "5.0000"); assert.equal(h.daily.usedPct, "50.0");
  assert.equal(h.monthly.usedUsd, "5.0000"); assert.equal(h.monthly.exceeded, true); assert.equal(h.monthly.headroomUsd, "-1.0000");
  assert.throws(() => computeOpsMetrics({ ...base([]), period: { fromIso: "2026-11-01T00:00:00Z", toIso: "2026-10-01T00:00:00Z" } }), /INVALID_PERIOD/);
});

test("consumo contra topes = greatest(reserva, costo final), incluso si el costo final supera la reserva", () => {
  const m = computeOpsMetrics(base([op("COMMITTED", "0.1000", "0.3000"), op("SUBMITTED", "0.2000")], { providerCaps: [{ origin: "synthetic", provider: "openai", dailyCapUsd: "0", monthlyCapUsd: "1", enabled: true }] }));
  const h = m.headroom.state === "KNOWN" ? m.headroom.providers[0] : null;
  assert.equal(h?.monthly.usedUsd, "0.5000");
  assert.equal(h?.daily.capUsd, null); // tope 0 = sin definir, nunca "0 % usado"
});

test("margen: requiere precio y costo completo; sin precio → sin fuente de precio", () => {
  const prices = [{ origin: "synthetic" as const, projectId: "sintetico-p1", priceUsd: "1.0000", basis: "ejemplo" }];
  const done = computeOpsMetrics(base([op("COMMITTED", "0.3333", "0.3333")], { prices }));
  assert.deepEqual(done.byProject[0].margin, { state: "KNOWN", priceUsd: "1.0000", basis: "ejemplo", marginUsd: "0.6667", marginPct: "66.7" });
  const loss = computeOpsMetrics(base([op("COMMITTED", "1.5", "1.5")], { prices }));
  assert.equal(loss.byProject[0].margin.state === "KNOWN" && loss.byProject[0].margin.marginPct, "-50.0");
  assert.equal(computeOpsMetrics(base([op("COMMITTED", "0.1", "0.1"), op("SUBMITTED", "0.1")], { prices })).byProject[0].margin.state, "UNCERTAIN");
  assert.equal(computeOpsMetrics(base([op("COMMITTED", "0.1", "0.1")])).byProject[0].margin.state, "NO_PRICE_SOURCE");
  assert.throws(() => computeOpsMetrics(base([], { prices: [...prices, ...prices] })), /DUPLICATE_PRICE/);
});

test("muchas filas (200 000) con importe máximo: BigInt evita desbordar y el resultado es exacto", () => {
  const rows = Array.from({ length: 200_000 }, (_, i) => op(i % 2 ? "COMMITTED" : "SUBMITTED", "99999999.9999", i % 2 ? "99999999.9999" : null, { provider: `p${i % 3}`, projectId: `sintetico-${i % 5}` }));
  const m = computeOpsMetrics(base(rows));
  assert.equal(m.totals.ops, 200_000);
  assert.equal(m.totals.committedUsd, "9999999999990.0000"); // 100 000 × 99 999 999.9999
  assert.equal(m.totals.uncertainUsd, "9999999999990.0000");
  assert.equal(m.byProvider.length, 3);
  assert.equal(m.byProject.length, 5);
});

test("fixture SINTÉTICO: totales, actividad, costo por video, topes y margen", () => {
  const m = computeOpsMetrics(SYNTHETIC_INPUT);
  assert.equal(m.source.kind, "synthetic");
  assert.deepEqual(m.totals, { committedUsd: "0.5349", uncertainUsd: "1.6900", reservedNotSpentUsd: "0.0400", ops: 12, committedOps: 5, uncertainOps: 4, reservedOps: 1, releasedOps: 1, excludedOps: 1, committedWithoutAmount: 1, unknownStatusOps: 0 });
  assert.deepEqual({ ...m.activity, jobs: undefined }, { activeProviderCalls: 2, reconciliationRequired: 1, refundsUnreconciled: 1, jobs: undefined });
  assert.deepEqual(m.activity.jobs, { state: "KNOWN", running: 1, queued: 1, failed: 1, completed: 1, other: 0 });
  const p = Object.fromEntries(m.byProject.map(x => [x.projectId, x]));
  assert.equal(p["sintetico-reel-001"].committedUsd, "0.3715");
  assert.deepEqual(p["sintetico-reel-001"].cap, { capUsd: "1.0000", kind: "tope por Reel (ejemplo)", headroomUsd: "0.6285", exceeded: false });
  assert.deepEqual(p["sintetico-reel-001"].margin, { state: "KNOWN", priceUsd: "1.2667", basis: "precio de ejemplo", marginUsd: "0.8952", marginPct: "70.7" });
  assert.equal(p["sintetico-reel-002"].margin.state, "UNCERTAIN");
  assert.equal(p["sintetico-largo-001"].cap?.headroomUsd, "0.1766");
  assert.equal(p["sintetico-largo-001"].margin.state, "NO_PRICE_SOURCE");
  assert.equal(p["sintetico-podcast-001"].ops, 2);
  assert.deepEqual(m.margins, { state: "PARTIAL", priced: 2, unpriced: 2 });
  assert.deepEqual(m.byDay.map(d => d.day), ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"]);
  const h = m.headroom.state === "KNOWN" ? Object.fromEntries(m.headroom.providers.map(x => [x.provider, x])) : {};
  assert.equal(h.openai.daily.usedPct, "4.0");
  assert.equal(h.openai.monthly.usedUsd, "0.1200");
  assert.equal(h.veo.monthly.exceeded, true);
  assert.equal(h.heygen.monthly.capUsd, null);
});
