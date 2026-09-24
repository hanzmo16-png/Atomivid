import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPendingEvaluationRecord,
  validateEvaluationRecord,
  pendingEvaluationCriteria,
  AiVideoEvaluationInvalidError,
} from "./ai-video-evaluation";

test("createPendingEvaluationRecord produce un registro con generationSuccess=false y timestamp", () => {
  const record = createPendingEvaluationRecord({
    benchmarkId: "bench-1",
    shotId: "s1",
    provider: "fixture",
    model: "fixture-placeholder-clip",
    executionMode: "simulation",
  });
  assert.equal(record.generationSuccess, false);
  assert.ok(record.evaluatedAtIso.length > 0);
});

test("un registro completo y consistente (generationSuccess=true con duración/costo) valida sin lanzar", () => {
  const record = createPendingEvaluationRecord({
    benchmarkId: "bench-1",
    shotId: "s1",
    provider: "runway",
    model: "gen4_turbo",
    executionMode: "real",
  });
  record.generationSuccess = true;
  record.durationSeconds = 5;
  record.costUsd = 0.25;
  record.promptAdherence = 4;
  record.usableInFinalEdit = true;
  assert.doesNotThrow(() => validateEvaluationRecord(record));
});

test("usableInFinalEdit=true con generationSuccess=false es inválido — nada generado no puede ser usable", () => {
  const record = createPendingEvaluationRecord({ benchmarkId: "b", shotId: "s1", provider: "fixture", model: "x", executionMode: "simulation" });
  record.usableInFinalEdit = true;
  assert.throws(() => validateEvaluationRecord(record), AiVideoEvaluationInvalidError);
});

test("durationSeconds/costUsd presentes con generationSuccess=false es inválido", () => {
  const record = createPendingEvaluationRecord({ benchmarkId: "b", shotId: "s1", provider: "fixture", model: "x", executionMode: "simulation" });
  record.durationSeconds = 5;
  assert.throws(() => validateEvaluationRecord(record), AiVideoEvaluationInvalidError);
});

test("executionMode='real' con provider='fixture' es inválido — ninguna fixture puede confundirse con output real", () => {
  const record = createPendingEvaluationRecord({ benchmarkId: "b", shotId: "s1", provider: "fixture", model: "x", executionMode: "real" });
  assert.throws(() => validateEvaluationRecord(record), AiVideoEvaluationInvalidError);
});

test("executionMode='simulation' con provider='fixture' es válido (el caso normal en P1/P2A)", () => {
  const record = createPendingEvaluationRecord({ benchmarkId: "b", shotId: "s1", provider: "fixture", model: "x", executionMode: "simulation" });
  assert.doesNotThrow(() => validateEvaluationRecord(record));
});

test("una puntuación subjetiva fuera de [0,5] es inválida", () => {
  const record = createPendingEvaluationRecord({ benchmarkId: "b", shotId: "s1", provider: "runway", model: "x", executionMode: "real" });
  record.generationSuccess = true;
  record.durationSeconds = 5;
  record.costUsd = 0.25;
  // @ts-expect-error -- forzamos un valor fuera de rango para probar la validación
  record.motionQuality = 7;
  assert.throws(() => validateEvaluationRecord(record), AiVideoEvaluationInvalidError);
});

test("validateEvaluationRecord acumula TODAS las razones encontradas, no solo la primera", () => {
  const record = createPendingEvaluationRecord({ benchmarkId: "b", shotId: "s1", provider: "fixture", model: "x", executionMode: "real" });
  record.usableInFinalEdit = true;
  try {
    validateEvaluationRecord(record);
    assert.fail("debía lanzar");
  } catch (err) {
    assert.ok(err instanceof AiVideoEvaluationInvalidError);
    assert.ok(err.reasons.length >= 2); // usableInFinalEdit + executionMode=real/fixture
  }
});

test("pendingEvaluationCriteria devuelve solo los criterios requeridos que todavía no tienen valor", () => {
  const record = createPendingEvaluationRecord({ benchmarkId: "b", shotId: "s1", provider: "runway", model: "x", executionMode: "real" });
  record.motionQuality = 4;
  const pending = pendingEvaluationCriteria(record, ["motionQuality", "temporalConsistency", "humanAnatomyQuality"]);
  assert.deepEqual(pending, ["temporalConsistency", "humanAnatomyQuality"]);
});
