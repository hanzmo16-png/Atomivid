// Pruebas de render con datos SINTÉTICOS (datos de ejemplo): ninguna cifra es real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { OpsMetricsPanel, DataSourceBadge } from "./OpsMetricsPanel";
import { computeOpsMetrics } from "@/lib/ops-panel/metrics";
import { SYNTHETIC_INPUT } from "@/lib/ops-panel/fixture";

test("panel operativo con fixture SINTÉTICO: insignia, gasto confirmado vs incierto, costo por video, topes y margen", () => {
  const html = renderToStaticMarkup(<OpsMetricsPanel metrics={computeOpsMetrics(SYNTHETIC_INPUT)} />);
  assert.ok(html.includes('data-source="synthetic"'));
  assert.ok(html.includes("SINTÉTICO · datos de ejemplo, no son cifras reales"));
  assert.ok(!html.includes("Datos reales"));
  assert.ok(html.includes('aria-labelledby="ops-title"'));
  assert.ok(html.includes("0.5349 USD")); assert.ok(html.includes("1.6900 USD")); assert.ok(html.includes("0.0400 USD"));
  assert.ok(html.includes("1 sin importe final (se usa la reserva)"));
  assert.ok(html.includes("Requieren conciliación"));
  assert.ok(html.includes("1 en curso · 1 en espera · 1 fallidos"));
  assert.ok(html.includes("sintetico-reel-001"));
  assert.ok(html.includes("holgura 0.6285 USD"));
  assert.ok(html.includes("0.8952 USD (70.7 %)"));
  assert.ok(html.includes("Sin fuente de precio"));
  assert.ok(html.includes("Margen parcial: 2 videos sin fuente de precio"));
  assert.ok(html.includes("costo final pendiente"));
  assert.ok(html.includes("excedido")); assert.ok(html.includes("Sin definir"));
});

test("estados vacío y de error: nunca cifras parciales ni ceros inventados", () => {
  const empty = computeOpsMetrics({ ...SYNTHETIC_INPUT, ledger: [], jobs: null, providerCaps: null, projectCaps: null, prices: null });
  const e = renderToStaticMarkup(<OpsMetricsPanel metrics={empty} />);
  assert.ok(e.includes("Sin operaciones registradas en el periodo"));
  assert.ok(e.includes("SINTÉTICO"));
  const err = renderToStaticMarkup(<OpsMetricsPanel metrics={null} error="MIXED_DATA_SOURCES" />);
  assert.ok(err.includes("No se pudieron calcular las métricas: MIXED_DATA_SOURCES"));
  assert.ok(!err.includes(" USD"));
  assert.ok(renderToStaticMarkup(<OpsMetricsPanel metrics={null} />).includes("No se muestran cifras parciales"));
});

test("sin fuentes opcionales: trabajos, topes y precio se declaran ausentes", () => {
  const m = computeOpsMetrics({ ...SYNTHETIC_INPUT, jobs: null, providerCaps: null, prices: null });
  const html = renderToStaticMarkup(<OpsMetricsPanel metrics={m} />);
  assert.ok(html.includes("Sin fuente de trabajos"));
  assert.ok(html.includes("Sin fuente de topes"));
  assert.ok(html.includes("Margen: sin fuente de precio"));
});

test("la insignia de datos reales es distinta y no dice SINTÉTICO", () => {
  const html = renderToStaticMarkup(<DataSourceBadge source={{ kind: "real", label: "pi_paid_operations", asOf: "2026-10-24T18:00:00Z" }} />);
  assert.ok(html.includes('data-source="real"')); assert.ok(html.includes("Datos reales")); assert.ok(!html.includes("SINTÉTICO"));
});
