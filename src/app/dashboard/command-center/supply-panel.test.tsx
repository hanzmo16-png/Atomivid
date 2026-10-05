import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SupplyPanel } from "./SupplyPanel";

test("supply panel distinguishes unknown supply from zero cash and exposes the alert backlog", () => {
  const html = renderToStaticMarkup(<SupplyPanel data={{ pendingAlerts: 2, queued: 3, states: [{ provider: "openai", level: "UNKNOWN", free: null, remainingRatio: null, coverageHours: null, reason: "unverified" }, { provider: "voice", unit: "character", level: "RED", free: 0, remainingRatio: 0, coverageHours: 0, reason: "empty" }] }} />);
  assert.ok(html.includes("Saldo libre: Sin verificar")); assert.ok(html.includes("0 caracteres"));
  assert.ok(html.includes("Avisos pendientes: 2")); assert.ok(html.includes("Trabajos en espera: 3"));
  assert.ok(html.includes('aria-labelledby="supply-title"'));
  assert.ok(renderToStaticMarkup(<SupplyPanel data={null} />).includes("No se autoriza gasto con datos desconocidos"));
});
