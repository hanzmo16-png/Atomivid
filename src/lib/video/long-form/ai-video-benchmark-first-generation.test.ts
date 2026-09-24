import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFirstGenerationPrep,
  RECOMMENDED_FIRST_BENCHMARK_SHOT_ID,
} from "./ai-video-benchmark-first-generation";
import { GOBEKLI_TEPE_BENCHMARK_SHOTS } from "./ai-video-benchmark-manifest";
import { AI_VIDEO_SCORE_THRESHOLD } from "./ai-video-eligibility";

test("el shot recomendado existe en el manifest del benchmark", () => {
  const shot = GOBEKLI_TEPE_BENCHMARK_SHOTS.find((s) => s.shotId === RECOMMENDED_FIRST_BENCHMARK_SHOT_ID);
  assert.ok(shot);
});

test("buildFirstGenerationPrep nunca llama a ningún proveedor real — solo construye datos, sin red (verificado por ausencia de I/O, la función es síncrona en la práctica salvo el import ya resuelto)", () => {
  const prep = buildFirstGenerationPrep();
  assert.equal(prep.shot.shotId, RECOMMENDED_FIRST_BENCHMARK_SHOT_ID);
});

test("el prep incluye un prompt normalizado no vacío y negativePrompt con las negative constraints del shot", () => {
  const prep = buildFirstGenerationPrep();
  assert.ok(prep.normalizedRequest.prompt.length > 0);
  assert.ok(prep.normalizedRequest.prompt.includes(prep.shot.visualIntent));
  for (const constraint of prep.shot.negativeConstraints) {
    assert.ok(prep.normalizedRequest.negativePrompt?.includes(constraint));
  }
});

test("la elegibilidad calculada para el shot recomendado es ai_video, por encima del umbral", () => {
  const prep = buildFirstGenerationPrep();
  assert.equal(prep.eligibility.recommendedAssetType, "ai_video");
  assert.ok(prep.eligibility.eligibilityScore >= AI_VIDEO_SCORE_THRESHOLD);
});

test("el costo estimado es positivo y viaja marcado como NO verificado contra doc primaria", () => {
  const prep = buildFirstGenerationPrep();
  assert.ok(prep.costEstimateUsd > 0);
  assert.equal(prep.costEstimateVerified, false);
});

test("el prep incluye retry policy, fallback chain no vacía, y al menos 3 criterios de éxito", () => {
  const prep = buildFirstGenerationPrep();
  assert.ok(prep.retryPolicy.length > 0);
  assert.ok(prep.fallbackChain.length > 0);
  assert.ok(prep.successCriteria.length >= 3);
  assert.ok(prep.rationale.length > 0);
});

test("un costModel explícito distinto (p. ej. otro proveedor hipotético) se respeta en vez del default de Runway", () => {
  const prep = buildFirstGenerationPrep({
    provider: "luma",
    model: "dream-machine",
    costPerSecondUsd: 0.1,
    verifiedAgainstPrimaryDocs: false,
  });
  assert.equal(prep.candidateProvider, "luma");
  assert.equal(prep.candidateModel, "dream-machine");
  assert.equal(prep.costEstimateUsd, prep.shot.durationSec * 0.1);
});
