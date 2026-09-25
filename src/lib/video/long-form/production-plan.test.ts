import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeProductionPlan,
  estimateNarrationSeconds,
  strategyToAiVideoCostPreset,
  isProductionPlan,
  VISUAL_STRATEGIES,
} from "./production-plan";

const PROVIDERS = { voice: "elevenlabs", footage: "pexels-video-first", image: "openai", aiVideo: "veo", music: "curated-library" };

function beats(n: number, wordsPerBeat = 120) {
  return Array.from({ length: n }, (_, i) => ({
    id: `beat-${i + 1}`,
    type: "setup" as const,
    narration: Array.from({ length: wordsPerBeat }, () => "palabra").join(" "),
  }));
}

test("estimateNarrationSeconds: usa WORDS_PER_SECOND real, nunca inventa una tasa", () => {
  const seconds = estimateNarrationSeconds("una dos tres cuatro cinco seis siete ocho");
  assert.ok(seconds > 0 && seconds < 10);
});

test("strategyToAiVideoCostPreset: mapea 1:1 a los presets reales de ai-video-cost-guard.ts", () => {
  assert.equal(strategyToAiVideoCostPreset("economical"), "economic");
  assert.equal(strategyToAiVideoCostPreset("balanced"), "balanced");
  assert.equal(strategyToAiVideoCostPreset("cinematic"), "premium");
});

test("computeProductionPlan: determinístico — mismo input produce siempre el mismo plan", () => {
  const input = { beats: beats(5), strategy: "balanced" as const, providers: PROVIDERS };
  const a = computeProductionPlan(input);
  const b = computeProductionPlan(input);
  assert.deepEqual(a, b);
});

test("computeProductionPlan: economical NUNCA incluye ai_video ni imagen IA (generated_placeholder)", () => {
  const plan = computeProductionPlan({ beats: beats(6), strategy: "economical", providers: PROVIDERS });
  assert.equal(plan.aiVideoClipCount, 0);
  assert.equal(plan.aiVideoSeconds, 0);
  assert.equal(plan.aiImageCount, 0);
  assert.ok(plan.shotCount > 0, "debe seguir teniendo shots (stock/deterministico)");
});

test("computeProductionPlan: cinematic SÍ puede incluir clips ai_video (a diferencia de balanced/economical)", () => {
  const cinematic = computeProductionPlan({ beats: beats(6), strategy: "cinematic", providers: PROVIDERS });
  const balanced = computeProductionPlan({ beats: beats(6), strategy: "balanced", providers: PROVIDERS });
  assert.ok(cinematic.aiVideoClipCount > 0, "cinematic debe planear al menos un clip ai_video con suficientes beats");
  assert.equal(balanced.aiVideoClipCount, 0, "balanced no incluye ai_video en su ciclo — sin cambios respecto al comportamiento histórico");
});

test("computeProductionPlan: cinematic cuesta más que economical para el mismo guion (más IA generativa planificada)", () => {
  const input5 = beats(6);
  const economical = computeProductionPlan({ beats: input5, strategy: "economical", providers: PROVIDERS });
  const cinematic = computeProductionPlan({ beats: input5, strategy: "cinematic", providers: PROVIDERS });
  assert.ok(
    cinematic.estimatedProviderCostUsd > economical.estimatedProviderCostUsd,
    `cinematic ($${cinematic.estimatedProviderCostUsd}) debería costar más que economical ($${economical.estimatedProviderCostUsd})`,
  );
});

test("computeProductionPlan: estimatedCredits es null — nunca se inventa un sistema de créditos inexistente", () => {
  const plan = computeProductionPlan({ beats: beats(3), strategy: "balanced", providers: PROVIDERS });
  assert.equal(plan.estimatedCredits, null);
});

test("computeProductionPlan: confirmedAt siempre null en el cálculo — solo actions.ts lo fija al confirmar", () => {
  const plan = computeProductionPlan({ beats: beats(3), strategy: "balanced", providers: PROVIDERS });
  assert.equal(plan.confirmedAt, null);
});

test("computeProductionPlan: voiceCharacters coincide exactamente con la suma de caracteres de narración", () => {
  const b = beats(4, 80);
  const plan = computeProductionPlan({ beats: b, strategy: "balanced", providers: PROVIDERS });
  const expected = b.reduce((sum, x) => sum + x.narration.length, 0);
  assert.equal(plan.voiceCharacters, expected);
});

test("isProductionPlan: valida forma real, rechaza valores ajenos", () => {
  const plan = computeProductionPlan({ beats: beats(2), strategy: "economical", providers: PROVIDERS });
  assert.equal(isProductionPlan(plan), true);
  assert.equal(isProductionPlan(null), false);
  assert.equal(isProductionPlan({}), false);
  assert.equal(isProductionPlan({ ...plan, strategy: "not-a-strategy" }), false);
});

test("VISUAL_STRATEGIES: exactamente 3 estrategias, sin duplicados", () => {
  assert.deepEqual([...VISUAL_STRATEGIES].sort(), ["balanced", "cinematic", "economical"]);
});
