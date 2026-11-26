import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceSentinelPanel } from "./ResourceSentinelPanel";
import { buildSentinelView } from "@/lib/command-center/sentinel/view";
import { SENTINEL_CONTRACT_VERSION } from "@/lib/command-center/sentinel/contract";

const NOW = "2026-11-27T15:00:00.000Z";

test("panel Sentinel: tarjetas por proveedor con semáforo, saldo, consumo, autonomía, alertas, enlace y hora", () => {
  const html = renderToStaticMarkup(<ResourceSentinelPanel view={buildSentinelView({
    version: SENTINEL_CONTRACT_VERSION, generatedAt: NOW, timezone: "America/Cancun", source: "existing-supply-tables", errors: ["pi_supply_alerts unavailable"],
    providers: [
      { provider: "elevenlabs", unit: "character", balance: { value: 1200, checkedAt: "2026-11-27T14:58:00.000Z", source: "provider_api", stale: false, health: "OK" }, committedUsd: 0, openOperations: 0, free: 1200, consumptionUsd: { day: 0, week: 3, month: 9 }, autonomy: { days: 0.5, basis: "engine" }, level: "RED", reason: "RED", limits: { dailyUsd: 3, monthlyUsd: 30, enabled: true }, recentAlerts: null },
      { provider: "luma", unit: null, balance: { value: null, checkedAt: null, source: null, stale: false, health: null }, committedUsd: null, openOperations: null, free: null, consumptionUsd: { day: null, week: null, month: null }, autonomy: { days: null, basis: null }, level: "UNKNOWN", reason: "policy unconfigured", limits: null, recentAlerts: null },
    ],
  })} />);
  assert.ok(html.includes('aria-labelledby="sentinel-title"'));
  assert.ok(html.includes('data-testid="sentinel-card-elevenlabs"') && html.includes('data-level="RED"'));
  assert.ok(html.includes("Semáforo: Recargar ya"));
  assert.ok(html.includes("1,200 caracteres"));
  assert.ok(html.includes("12 h"), "autonomía de medio día en horas");
  assert.ok(html.includes("Recarga urgente"));
  assert.ok(html.includes('href="https://elevenlabs.io/app/subscription"') && html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes("Última actualización") && html.includes('dateTime="2026-11-27T14:58:00.000Z"'));
  // Desconocido explícito, sin cifras inventadas.
  assert.ok(html.includes('data-testid="sentinel-card-luma"') && html.includes("Semáforo: Desconocido"));
  assert.ok(html.includes("Nunca se registró un saldo verificable"));
  assert.ok(html.includes("Fuentes sin leer: pi_supply_alerts unavailable"));
  assert.ok(html.includes("1 proveedor requiere recarga o revisión."));
  assert.ok(html.includes("min-h-11"), "enlaces táctiles de 44 px");
});

test("panel Sentinel sin datos: aviso honesto, sin tarjetas", () => {
  const html = renderToStaticMarkup(<ResourceSentinelPanel view={buildSentinelView(null)} />);
  assert.ok(html.includes("No se autoriza gasto con datos desconocidos"));
  assert.ok(!html.includes("sentinel-card-"));
});
