import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeDryRunResponse } from "./visual-test-v2-display";

test("summarizeDryRunResponse: 200 con reporte completo se mapea a kind:'report'", () => {
  const result = summarizeDryRunResponse(200, {
    mode: "dry_run",
    openaiApiKeyAvailable: true,
    shots: [
      { shotId: "b1-s4", wouldGenerate: true, estimatedCostUsd: 0.05 },
      { shotId: "b4-s2", wouldGenerate: true, estimatedCostUsd: 0.05 },
      { shotId: "b8-s5", wouldGenerate: true, estimatedCostUsd: 0.05 },
    ],
    estimatedTotalUsd: 0.15,
    maxTotalUsd: 0.5,
    hardStopUsd: 3,
    withinCostGuard: true,
    realModeLocked: true,
    paidApisCalled: false,
  });
  assert.equal(result.kind, "report");
  if (result.kind !== "report") return;
  assert.equal(result.openaiApiKeyAvailable, true);
  assert.equal(result.shots.length, 3);
  assert.deepEqual(
    result.shots.map((s) => s.shotId),
    ["b1-s4", "b4-s2", "b8-s5"],
  );
  assert.equal(result.estimatedTotalUsd, 0.15);
  assert.equal(result.maxTotalUsd, 0.5);
  assert.equal(result.hardStopUsd, 3);
  assert.equal(result.withinCostGuard, true);
  assert.equal(result.realModeLocked, true);
  assert.equal(result.paidApisCalled, false);
  assert.equal("costGuardBlockReason" in result, false);
});

test("summarizeDryRunResponse: 401/403/400 se mapean a kind:'error' con el mensaje del backend", () => {
  for (const status of [401, 403, 400]) {
    const result = summarizeDryRunResponse(status, { error: "No autorizado" });
    assert.equal(result.kind, "error");
    if (result.kind !== "error") continue;
    assert.equal(result.httpStatus, status);
    assert.equal(result.message, "No autorizado");
  }
});

test("summarizeDryRunResponse: error sin campo 'error' válido cae a mensaje genérico seguro (nunca undefined/crash)", () => {
  const result = summarizeDryRunResponse(500, {});
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.ok(result.message.length > 0);
});

test("summarizeDryRunResponse: body null/no-objeto en cualquier status nunca lanza", () => {
  assert.doesNotThrow(() => summarizeDryRunResponse(500, null));
  assert.doesNotThrow(() => summarizeDryRunResponse(200, null));
  assert.doesNotThrow(() => summarizeDryRunResponse(200, "no es un objeto"));
  assert.doesNotThrow(() => summarizeDryRunResponse(200, undefined));
});

test("summarizeDryRunResponse: campos inesperados/extra en el body (p. ej. una key con apariencia de secreto) NUNCA aparecen en el resultado — solo se copian los campos conocidos", () => {
  const result = summarizeDryRunResponse(200, {
    openaiApiKeyAvailable: true,
    shots: [],
    estimatedTotalUsd: 0.15,
    maxTotalUsd: 0.5,
    hardStopUsd: 3,
    withinCostGuard: true,
    realModeLocked: true,
    paidApisCalled: false,
    // campo inesperado que NO debería propagarse nunca a la UI
    OPENAI_API_KEY: "sk-esto-nunca-deberia-verse-en-la-ui",
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("sk-esto-nunca-deberia-verse-en-la-ui"), false);
  assert.equal(serialized.includes("OPENAI_API_KEY"), false);
});

test("summarizeDryRunResponse: withinCostGuard=false incluye costGuardBlockReason cuando el backend lo manda", () => {
  const result = summarizeDryRunResponse(200, {
    openaiApiKeyAvailable: false,
    shots: [],
    estimatedTotalUsd: 0.15,
    maxTotalUsd: 0.5,
    hardStopUsd: 3,
    withinCostGuard: false,
    costGuardBlockReason: "Barrera de costo de VIDEO #001 activada...",
    realModeLocked: true,
    paidApisCalled: false,
  });
  assert.equal(result.kind, "report");
  if (result.kind !== "report") return;
  assert.equal(result.withinCostGuard, false);
  assert.equal(result.costGuardBlockReason, "Barrera de costo de VIDEO #001 activada...");
});

test("summarizeDryRunResponse: shots con entradas mal formadas no rompe — usa valores por defecto seguros", () => {
  const result = summarizeDryRunResponse(200, {
    openaiApiKeyAvailable: true,
    shots: [null, {}, { shotId: 123, wouldGenerate: "sí", estimatedCostUsd: "gratis" }],
    estimatedTotalUsd: 0.15,
    maxTotalUsd: 0.5,
    hardStopUsd: 3,
    withinCostGuard: true,
    realModeLocked: true,
    paidApisCalled: false,
  });
  assert.equal(result.kind, "report");
  if (result.kind !== "report") return;
  assert.equal(result.shots.length, 3);
  for (const shot of result.shots) {
    assert.equal(typeof shot.shotId, "string");
    assert.equal(typeof shot.wouldGenerate, "boolean");
    assert.equal(typeof shot.estimatedCostUsd, "number");
  }
});
