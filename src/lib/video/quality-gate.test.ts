import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateQualityGate, QUALITY_GATE_MIN_SCORE } from "./quality-gate";

function baseInput(overrides: Partial<Parameters<typeof evaluateQualityGate>[0]> = {}) {
  return {
    totalBeats: 8,
    uniqueSourceIds: 8,
    fallbackCount: 0,
    averageConceptTier: 0,
    beatDurations: [2.1, 2.8, 3.2, 2.4, 3.5, 2.0, 2.9, 3.1],
    durationWithinTolerance: true,
    ...overrides,
  };
}

test("una selección ideal (toda del concepto principal, sin fallback, ritmo variado) aprueba con score alto", () => {
  const result = evaluateQualityGate(baseInput());
  assert.equal(result.passed, true);
  assert.ok(result.score >= 80, `score=${result.score}`);
  assert.equal(result.diversityScore, 100);
});

test("clips repetidos (uniqueSourceIds < totalBeats) bajan el score de diversidad", () => {
  const result = evaluateQualityGate(baseInput({ uniqueSourceIds: 5, totalBeats: 8 }));
  assert.ok(result.diversityScore < 100);
  assert.ok(result.reasons.some((r) => r.includes("diversidad")));
});

test("mucho fallback/reformulación baja la adherencia al plan", () => {
  const result = evaluateQualityGate(baseInput({ fallbackCount: 6, totalBeats: 8 }));
  assert.ok(result.planAdherenceScore < 100);
  assert.ok(result.reasons.some((r) => r.includes("reformular")));
});

test("un tier de concepto promedio alto (siempre alternativas, nunca el principal) baja la adherencia", () => {
  const withPrimary = evaluateQualityGate(baseInput({ averageConceptTier: 0 }));
  const withAlternates = evaluateQualityGate(baseInput({ averageConceptTier: 2 }));
  assert.ok(withAlternates.planAdherenceScore < withPrimary.planAdherenceScore);
});

test("planos fuera de 1.8-3.8s bajan el score de ritmo", () => {
  const result = evaluateQualityGate(baseInput({ beatDurations: [5, 6, 7, 8] }));
  assert.ok(result.pacingScore < 100);
  assert.ok(result.reasons.some((r) => r.includes("1.8-3.8s")));
});

test("todos los planos con exactamente la misma duración se marcan como sin variación de ritmo", () => {
  const result = evaluateQualityGate(baseInput({ beatDurations: [3, 3, 3, 3] }));
  assert.ok(result.reasons.some((r) => r.includes("sin variación")));
});

test("duración fuera de tolerancia se refleja en el score y en las razones", () => {
  const withinTolerance = evaluateQualityGate(baseInput({ durationWithinTolerance: true }));
  const outOfTolerance = evaluateQualityGate(baseInput({ durationWithinTolerance: false }));
  assert.ok(outOfTolerance.score < withinTolerance.score);
  assert.ok(outOfTolerance.reasons.some((r) => r.includes("duración total")));
});

test("un video con todo en contra (repetidos, fallback constante, mal ritmo) no aprueba", () => {
  const result = evaluateQualityGate({
    totalBeats: 8,
    uniqueSourceIds: 3,
    fallbackCount: 8,
    averageConceptTier: 3,
    beatDurations: [8, 9, 10, 1, 1, 1, 1, 1],
    durationWithinTolerance: false,
  });
  assert.equal(result.passed, false);
  assert.ok(result.score < QUALITY_GATE_MIN_SCORE);
});

test("el score siempre queda entre 0 y 100", () => {
  const worst = evaluateQualityGate({
    totalBeats: 10,
    uniqueSourceIds: 1,
    fallbackCount: 10,
    averageConceptTier: 5,
    beatDurations: Array(10).fill(0.1),
    durationWithinTolerance: false,
  });
  assert.ok(worst.score >= 0 && worst.score <= 100);
});
