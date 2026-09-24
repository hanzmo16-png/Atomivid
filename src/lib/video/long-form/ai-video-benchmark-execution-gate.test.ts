import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBenchmarkExecutionGate,
  assertBenchmarkExecutionAllowed,
  BenchmarkExecutionNotAllowedError,
  type BenchmarkExecutionGateParams,
} from "./ai-video-benchmark-execution-gate";

const ALL_ALLOWED: BenchmarkExecutionGateParams = {
  referenceImageStatus: "approved",
  longFormAiVideoEnabled: true,
  explicitBenchmarkExecutionMode: true,
  costGuardAllowed: true,
  providerConfigured: true,
};

test("las 5 condiciones true -> allowed=true", () => {
  const decision = evaluateBenchmarkExecutionGate(ALL_ALLOWED);
  assert.equal(decision.allowed, true);
});

test("referenceImageStatus != 'approved' bloquea, sin importar el resto", () => {
  for (const status of ["not_generated", "pending_review"] as const) {
    const decision = evaluateBenchmarkExecutionGate({ ...ALL_ALLOWED, referenceImageStatus: status });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.ok(decision.reasons.some((r) => r.includes("referenceImageStatus")));
  }
});

test("LONG_FORM_AI_VIDEO_ENABLED=false bloquea, aunque todo lo demás esté permitido", () => {
  const decision = evaluateBenchmarkExecutionGate({ ...ALL_ALLOWED, longFormAiVideoEnabled: false });
  assert.equal(decision.allowed, false);
});

test("explicitBenchmarkExecutionMode=false bloquea — configurar solo la API key nunca dispara generación", () => {
  const decision = evaluateBenchmarkExecutionGate({ ...ALL_ALLOWED, explicitBenchmarkExecutionMode: false });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.ok(decision.reasons.some((r) => r.includes("explicitBenchmarkExecutionMode")));
});

test("costGuardAllowed=false bloquea", () => {
  const decision = evaluateBenchmarkExecutionGate({ ...ALL_ALLOWED, costGuardAllowed: false });
  assert.equal(decision.allowed, false);
});

test("providerConfigured=false bloquea", () => {
  const decision = evaluateBenchmarkExecutionGate({ ...ALL_ALLOWED, providerConfigured: false });
  assert.equal(decision.allowed, false);
});

test("con TODAS las condiciones fallando, se acumulan las 5 razones (nunca solo la primera)", () => {
  const decision = evaluateBenchmarkExecutionGate({
    referenceImageStatus: "not_generated",
    longFormAiVideoEnabled: false,
    explicitBenchmarkExecutionMode: false,
    costGuardAllowed: false,
    providerConfigured: false,
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.reasons.length, 5);
});

test("assertBenchmarkExecutionAllowed lanza BenchmarkExecutionNotAllowedError cuando el gate bloquea", () => {
  assert.throws(
    () => assertBenchmarkExecutionAllowed({ ...ALL_ALLOWED, providerConfigured: false }),
    BenchmarkExecutionNotAllowedError,
  );
});

test("assertBenchmarkExecutionAllowed no lanza cuando las 5 condiciones se cumplen", () => {
  assert.doesNotThrow(() => assertBenchmarkExecutionAllowed(ALL_ALLOWED));
});
