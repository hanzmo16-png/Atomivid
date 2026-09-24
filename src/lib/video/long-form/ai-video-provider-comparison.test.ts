import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateComparisonMatrixCost,
  buildProviderShotPrep,
  buildPillarTransportVeoFinalSpec,
  PILLAR_TRANSPORT_VEO_FINAL_PROMPT,
  PILLAR_TRANSPORT_VEO_FINAL_RESTRICTIONS,
  KLING_COST_MODEL_LOW,
  KLING_COST_MODEL_HIGH,
  VEO_COST_MODEL,
  KLING_PLANNING_DURATION_SEC,
  VEO_PLANNING_DURATION_SEC,
} from "./ai-video-provider-comparison";
import { ACTIVE_BENCHMARK_SHOTS } from "./ai-video-benchmark-v2-active";

test("la matriz de comparación tiene exactamente 4 celdas (2 shots x 2 proveedores)", () => {
  const matrix = estimateComparisonMatrixCost();
  assert.equal(matrix.cells.length, 4);
  const providers = matrix.cells.map((c) => c.provider).sort();
  assert.deepEqual(providers, ["kling", "kling", "veo", "veo"]);
});

test("ningún costo de Kling se calcula fuera del rango [low,high] declarado", () => {
  const matrix = estimateComparisonMatrixCost();
  for (const cell of matrix.cells.filter((c) => c.provider === "kling")) {
    assert.ok(Math.abs(cell.costUsdLow - KLING_COST_MODEL_LOW.costPerSecondUsd * KLING_PLANNING_DURATION_SEC) < 1e-6);
    assert.ok(Math.abs(cell.costUsdHigh - KLING_COST_MODEL_HIGH.costPerSecondUsd * KLING_PLANNING_DURATION_SEC) < 1e-6);
    assert.ok(cell.costUsdLow <= cell.costUsdHigh);
  }
});

test("Veo usa una duración de 8s (planeación) y una tarifa fija — costUsdLow == costUsdHigh (sin rango, mayor consenso de fuentes)", () => {
  const matrix = estimateComparisonMatrixCost();
  for (const cell of matrix.cells.filter((c) => c.provider === "veo")) {
    assert.equal(cell.durationSec, VEO_PLANNING_DURATION_SEC);
    assert.equal(cell.costUsdLow, cell.costUsdHigh);
    assert.equal(cell.costUsdHigh, VEO_COST_MODEL.costPerSecondUsd * VEO_PLANNING_DURATION_SEC);
  }
});

test("el peor caso con 1 reintento POR RESULTADO duplica el total (8 intentos posibles, no solo 1 reintento compartido)", () => {
  const matrix = estimateComparisonMatrixCost();
  assert.equal(matrix.worstCaseWithOneRetryEachUsdLow, matrix.totalCostUsdLow * 2);
  assert.equal(matrix.worstCaseWithOneRetryEachUsdHigh, matrix.totalCostUsdHigh * 2);
});

test("el peor caso (extremo alto de Kling) cabe bajo el techo de $15", () => {
  const matrix = estimateComparisonMatrixCost();
  assert.ok(matrix.worstCaseWithOneRetryEachUsdHigh <= 15);
  assert.equal(matrix.withinCeiling, true);
});

test("buildProviderShotPrep para Pillar Transport x Kling: normalizedRequest sin referenceImageUrl (todavía no generada)", () => {
  const shotA = ACTIVE_BENCHMARK_SHOTS.find((s) => s.title === "Pillar Transport")!;
  const prep = buildProviderShotPrep(shotA, "kling");
  assert.equal(prep.provider, "kling");
  assert.equal(prep.durationSec, KLING_PLANNING_DURATION_SEC);
  assert.equal(prep.normalizedRequest.referenceImageUrl, undefined);
  assert.equal(prep.exactProviderRequestStatus, "not_available_contract_unverified");
  assert.ok(prep.successCriteria.length > 0);
});

test("buildProviderShotPrep para Pillar Transport x Veo: duración 8s, audioNote explica que Veo siempre genera audio y no se inventa un switch", () => {
  const shotA = ACTIVE_BENCHMARK_SHOTS.find((s) => s.title === "Pillar Transport")!;
  const prep = buildProviderShotPrep(shotA, "veo");
  assert.equal(prep.provider, "veo");
  assert.equal(prep.durationSec, VEO_PLANNING_DURATION_SEC);
  assert.match(prep.audioNote, /SIEMPRE/);
  assert.match(prep.audioNote, /nunca se inventa/);
});

test("ningún prep expone un 'exact provider request' inventado — siempre marcado not_available_contract_unverified (incluso para Veo, que ya tiene contrato implementado)", () => {
  for (const shot of ACTIVE_BENCHMARK_SHOTS) {
    for (const provider of ["kling", "veo"] as const) {
      const prep = buildProviderShotPrep(shot, provider);
      assert.equal(prep.exactProviderRequestStatus, "not_available_contract_unverified");
    }
  }
});

test("costVerifiedAgainstPrimaryDocs es true para Veo (P2A.5, confirmado por Hans) y sigue false para Kling (sin verificar)", () => {
  const shotA = ACTIVE_BENCHMARK_SHOTS.find((s) => s.title === "Pillar Transport")!;
  assert.equal(buildProviderShotPrep(shotA, "veo").costVerifiedAgainstPrimaryDocs, true);
  assert.equal(buildProviderShotPrep(shotA, "kling").costVerifiedAgainstPrimaryDocs, false);
});

test("el storagePathIfGenerated es determinístico e incluye el benchmarkId/shotId/provider", () => {
  const shotA = ACTIVE_BENCHMARK_SHOTS.find((s) => s.title === "Pillar Transport")!;
  const prep = buildProviderShotPrep(shotA, "kling");
  assert.ok(prep.storagePathIfGenerated.includes(shotA.benchmarkId));
  assert.ok(prep.storagePathIfGenerated.includes(shotA.shotId));
  assert.ok(prep.storagePathIfGenerated.includes("kling"));
});

test("el costo de Veo en la matriz es $0.96 por clip (8s x $0.12/s, P2A.5), no el $1.20 anterior", () => {
  const matrix = estimateComparisonMatrixCost();
  for (const cell of matrix.cells.filter((c) => c.provider === "veo")) {
    assert.equal(cell.costUsdHigh, 0.96);
  }
});

test("dos generaciones Veo = $1.92, con 1 retry cada una = $3.84 (P2A.5 sección 10)", () => {
  const matrix = estimateComparisonMatrixCost();
  const veoCells = matrix.cells.filter((c) => c.provider === "veo");
  const veoTotal = veoCells.reduce((sum, c) => sum + c.costUsdHigh, 0);
  assert.equal(Math.round(veoTotal * 100) / 100, 1.92);
  assert.equal(Math.round(veoTotal * 2 * 100) / 100, 3.84);
});

test("todo prep incluye un executionGate evaluado con el estado REAL actual — siempre allowed=false en P2A.5 (sin imagen aprobada, flag OFF, sin proveedor configurado)", () => {
  const shotA = ACTIVE_BENCHMARK_SHOTS.find((s) => s.title === "Pillar Transport")!;
  const prep = buildProviderShotPrep(shotA, "veo");
  assert.equal(prep.executionGate.allowed, false);
  if (!prep.executionGate.allowed) {
    assert.ok(prep.executionGate.reasons.length > 0);
    assert.ok(prep.executionGate.reasons.some((r) => r.includes("referenceImageStatus")));
    assert.ok(prep.executionGate.reasons.some((r) => r.includes("LONG_FORM_AI_VIDEO_ENABLED")));
  }
});

test("buildPillarTransportVeoFinalSpec() usa el prompt EXACTO de Hans (P2A.5 sección 13), no el visualIntent genérico del shot", () => {
  const spec = buildPillarTransportVeoFinalSpec();
  assert.equal(spec.provider, "veo");
  assert.equal(spec.normalizedRequest.prompt, PILLAR_TRANSPORT_VEO_FINAL_PROMPT);
  for (const restriction of PILLAR_TRANSPORT_VEO_FINAL_RESTRICTIONS) {
    assert.ok(spec.normalizedRequest.negativePrompt?.includes(restriction));
  }
  assert.equal(spec.durationSec, 8);
  assert.equal(spec.costEstimateUsdHigh, 0.96);
  assert.equal(spec.shot.historicalClassification, "reconstruction");
});

test("buildPillarTransportVeoFinalSpec() nunca incluye un campo API de audio inventado en el request normalizado", () => {
  const spec = buildPillarTransportVeoFinalSpec();
  const request = spec.normalizedRequest as Record<string, unknown>;
  assert.equal("audio" in request, false);
  assert.equal("audioEnabled" in request, false);
});
