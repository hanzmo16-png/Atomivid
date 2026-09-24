import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateBenchmarkClipCost,
  estimateBenchmarkSuiteCost,
  getMaxBenchmarkBudgetUsd,
  type BenchmarkCostModel,
} from "./ai-video-benchmark-cost";

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const key = "MAX_BENCHMARK_BUDGET_USD";
  const original = process.env[key];
  delete process.env[key];
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

const RUNWAY_MODEL: BenchmarkCostModel = {
  provider: "runway",
  model: "gen4_turbo",
  costPerSecondUsd: 0.05,
  verifiedAgainstPrimaryDocs: false,
};

test("getMaxBenchmarkBudgetUsd() default es $15", async () => {
  await withEnv({}, () => {
    assert.equal(getMaxBenchmarkBudgetUsd(), 15);
  });
});

test("getMaxBenchmarkBudgetUsd() respeta MAX_BENCHMARK_BUDGET_USD si está configurado", async () => {
  await withEnv({ MAX_BENCHMARK_BUDGET_USD: "30" }, () => {
    assert.equal(getMaxBenchmarkBudgetUsd(), 30);
  });
});

test("estimateBenchmarkClipCost multiplica duración x tarifa", () => {
  const estimate = estimateBenchmarkClipCost({ shotId: "s1", durationSec: 5 }, RUNWAY_MODEL);
  assert.equal(estimate.costUsd, 0.25);
});

test("estimateBenchmarkSuiteCost para los 5 shots del benchmark (5s c/u) cabe cómodamente bajo $15", () => {
  const shots = [
    { shotId: "a", durationSec: 5 },
    { shotId: "b", durationSec: 5 },
    { shotId: "c", durationSec: 5 },
    { shotId: "d", durationSec: 5 },
    { shotId: "e", durationSec: 5 },
  ];
  const estimate = estimateBenchmarkSuiteCost("gobekli-tepe-ai-video-benchmark-v1", shots, RUNWAY_MODEL);
  assert.equal(estimate.clipCount, 5);
  assert.equal(estimate.totalDurationSec, 25);
  assert.equal(estimate.totalCostUsd, 1.25);
  assert.equal(estimate.oneRetryCostUsd, 0.25);
  assert.equal(estimate.worstCaseCostUsd, 1.5);
  assert.equal(estimate.ceilingUsd, 15);
  assert.equal(estimate.withinCeiling, true);
});

test("el peor caso (con 1 reintento) usa el clip MÁS CARO del lote, no el promedio", () => {
  const shots = [
    { shotId: "short", durationSec: 3 },
    { shotId: "long", durationSec: 10 },
  ];
  const estimate = estimateBenchmarkSuiteCost("bench", shots, RUNWAY_MODEL);
  assert.equal(estimate.oneRetryCostUsd, 0.5); // 10s * 0.05, no el promedio (0.325)
});

test("withinCeiling=false cuando el peor caso excede el techo — nunca autoriza gasto, solo informa", () => {
  const expensiveModel: BenchmarkCostModel = { ...RUNWAY_MODEL, costPerSecondUsd: 5 };
  const shots = [{ shotId: "a", durationSec: 5 }];
  const estimate = estimateBenchmarkSuiteCost("bench", shots, expensiveModel, 15);
  assert.equal(estimate.totalCostUsd, 25);
  assert.equal(estimate.withinCeiling, false);
});

test("un lote vacío no lanza y da costo/duración 0", () => {
  const estimate = estimateBenchmarkSuiteCost("bench", [], RUNWAY_MODEL);
  assert.equal(estimate.clipCount, 0);
  assert.equal(estimate.totalCostUsd, 0);
  assert.equal(estimate.oneRetryCostUsd, 0);
  assert.equal(estimate.withinCeiling, true);
});

test("el costModel siempre viaja con verifiedAgainstPrimaryDocs en el resultado — nunca se pierde la procedencia del número", () => {
  const estimate = estimateBenchmarkSuiteCost("bench", [{ shotId: "a", durationSec: 5 }], RUNWAY_MODEL);
  assert.equal(estimate.costModel.verifiedAgainstPrimaryDocs, false);
  assert.equal(estimate.costModel.provider, "runway");
});
