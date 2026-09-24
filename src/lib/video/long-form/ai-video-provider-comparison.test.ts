import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateComparisonMatrixCost,
  buildProviderShotPrep,
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

test("buildProviderShotPrep para Pillar Transport x Veo: duración 8s, audioNote explica que no se inventa un switch", () => {
  const shotA = ACTIVE_BENCHMARK_SHOTS.find((s) => s.title === "Pillar Transport")!;
  const prep = buildProviderShotPrep(shotA, "veo");
  assert.equal(prep.provider, "veo");
  assert.equal(prep.durationSec, VEO_PLANNING_DURATION_SEC);
  assert.match(prep.audioNote, /no se confirmó/);
  assert.match(prep.audioNote, /nunca se inventa/);
});

test("ningún prep expone un 'exact provider request' inventado — siempre marcado not_available_contract_unverified", () => {
  for (const shot of ACTIVE_BENCHMARK_SHOTS) {
    for (const provider of ["kling", "veo"] as const) {
      const prep = buildProviderShotPrep(shot, provider);
      assert.equal(prep.exactProviderRequestStatus, "not_available_contract_unverified");
      assert.equal(prep.costVerifiedAgainstPrimaryDocs, false);
    }
  }
});

test("el storagePathIfGenerated es determinístico e incluye el benchmarkId/shotId/provider", () => {
  const shotA = ACTIVE_BENCHMARK_SHOTS.find((s) => s.title === "Pillar Transport")!;
  const prep = buildProviderShotPrep(shotA, "kling");
  assert.ok(prep.storagePathIfGenerated.includes(shotA.benchmarkId));
  assert.ok(prep.storagePathIfGenerated.includes(shotA.shotId));
  assert.ok(prep.storagePathIfGenerated.includes("kling"));
});
