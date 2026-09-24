import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAiVideoObservabilityRecord,
  assertNoSecretLeakage,
  AiVideoObservabilitySecretLeakageError,
} from "./ai-video-observability";

test("buildAiVideoObservabilityRecord incluye todos los campos pedidos por el encargo", () => {
  const record = buildAiVideoObservabilityRecord({
    provider: "runway",
    model: "gen4_turbo",
    benchmarkId: "bench-1",
    shotId: "s1",
    providerJobId: "task_abc",
    executionMode: "real",
    generationTimeMs: 42000,
    clipDurationSeconds: 5,
    estimatedCostUsd: 0.25,
    actualCostUsd: 0.25,
    retryCount: 1,
    validationResult: "valid",
  });
  for (const key of [
    "provider",
    "model",
    "benchmarkId",
    "shotId",
    "providerJobId",
    "executionMode",
    "generationTimeMs",
    "clipDurationSeconds",
    "estimatedCostUsd",
    "actualCostUsd",
    "retryCount",
    "validationResult",
  ]) {
    assert.ok(key in record, `falta el campo ${key}`);
  }
  assert.ok(record.recordedAtIso.length > 0);
});

test("retryCount por defecto es 0 si no se especifica", () => {
  const record = buildAiVideoObservabilityRecord({
    provider: "fixture",
    model: "fixture-placeholder-clip",
    shotId: "s1",
    executionMode: "simulation",
    estimatedCostUsd: 0,
    validationResult: "valid",
  });
  assert.equal(record.retryCount, 0);
});

test("un registro de fallo incluye failureReason/fallbackUsed", () => {
  const record = buildAiVideoObservabilityRecord({
    provider: "runway",
    model: "gen4_turbo",
    shotId: "s1",
    executionMode: "real",
    estimatedCostUsd: 0.25,
    retryCount: 2,
    failureReason: "moderation_rejected",
    fallbackUsed: "ai_image_motion",
    validationResult: "not_applicable",
  });
  assert.equal(record.failureReason, "moderation_rejected");
  assert.equal(record.fallbackUsed, "ai_image_motion");
});

test("assertNoSecretLeakage no lanza para un registro normal", () => {
  const record = buildAiVideoObservabilityRecord({
    provider: "fixture",
    model: "x",
    shotId: "s1",
    executionMode: "simulation",
    estimatedCostUsd: 0,
    validationResult: "valid",
  });
  assert.doesNotThrow(() => assertNoSecretLeakage(record as unknown as Record<string, unknown>));
});

test("assertNoSecretLeakage lanza si una clave del objeto se parece a un secreto/token/prompt", () => {
  const contaminated = { provider: "runway", apiKey: "sk-should-never-be-here" };
  assert.throws(() => assertNoSecretLeakage(contaminated), AiVideoObservabilitySecretLeakageError);

  const withPrompt = { provider: "runway", prompt: "the actual scene text" };
  assert.throws(() => assertNoSecretLeakage(withPrompt), AiVideoObservabilitySecretLeakageError);
});
