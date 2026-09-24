import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreAiVideoEligibility,
  scoreAiVideoEligibilityBatch,
  AI_VIDEO_SCORE_THRESHOLD,
  AI_IMAGE_MOTION_SCORE_THRESHOLD,
} from "./ai-video-eligibility";
import { getAiVideoCostConfig } from "./ai-video-cost-guard";

const BALANCED = getAiVideoCostConfig("balanced");

test("un shot determinístico (text/diagram/map) nunca es candidato — score 0, sin fallback", () => {
  for (const type of ["text", "diagram", "map"] as const) {
    const result = scoreAiVideoEligibility(
      { id: "s1", visualIntent: "people building a monument, carrying stones", durationSec: 5, type },
      BALANCED,
    );
    assert.equal(result.eligibilityScore, 0);
    assert.equal(result.recommendedAssetType, "real_image");
    assert.equal(result.estimatedCostUsd, 0);
    assert.deepEqual(result.fallback, []);
    assert.match(result.reason, /determinístico/);
  }
});

test("señales de BAJA necesidad de movimiento (mapa/inscripción/fotografía) producen score bajo → ai_image", () => {
  const result = scoreAiVideoEligibility(
    { id: "s2", visualIntent: "a static archival photograph of an ancient inscription", durationSec: 6 },
    BALANCED,
  );
  assert.ok(result.eligibilityScore < AI_IMAGE_MOTION_SCORE_THRESHOLD);
  assert.equal(result.recommendedAssetType, "ai_image");
  assert.equal(result.estimatedCostUsd, 0);
  assert.deepEqual(result.fallback, ["real_image"]);
});

test("señales de ALTA necesidad de movimiento (construir, cargar, trabajar) producen score alto → ai_video", () => {
  const result = scoreAiVideoEligibility(
    { id: "s3", visualIntent: "people building a monumental structure, carrying heavy stones, working together", durationSec: 5 },
    BALANCED,
  );
  // 3 señales altas: building, carrying, working -> 0.15 + 3*0.22 = 0.81
  assert.ok(result.eligibilityScore >= AI_VIDEO_SCORE_THRESHOLD, `score ${result.eligibilityScore} debería ser >= ${AI_VIDEO_SCORE_THRESHOLD}`);
  assert.equal(result.recommendedAssetType, "ai_video");
  assert.deepEqual(result.fallback, ["ai_image_motion", "ai_image", "real_image"]);
});

test("estimatedCostUsd = tarifa por segundo del tier recomendado x duración (preset balanced)", () => {
  const result = scoreAiVideoEligibility(
    { id: "s4", visualIntent: "people building, carrying, working", durationSec: 5 },
    BALANCED,
  );
  assert.equal(result.recommendedAssetType, "ai_video");
  assert.equal(result.estimatedCostUsd, 5 * BALANCED.aiVideoCostPerSecondUsd);
});

test("motionRequired=true da un boost al score aunque el texto sea neutro", () => {
  const withoutBoost = scoreAiVideoEligibility({ id: "s5", visualIntent: "a person standing", durationSec: 4 }, BALANCED);
  const withBoost = scoreAiVideoEligibility(
    { id: "s5", visualIntent: "a person standing", durationSec: 4, motionRequired: true },
    BALANCED,
  );
  assert.ok(withBoost.eligibilityScore > withoutBoost.eligibilityScore);
});

test("preferredAssetType explícito anula la recomendación calculada, pero el score se sigue reportando en el reason", () => {
  const result = scoreAiVideoEligibility(
    { id: "s6", visualIntent: "a static photograph", durationSec: 3, preferredAssetType: "ai_video" },
    BALANCED,
  );
  assert.equal(result.recommendedAssetType, "ai_video");
  assert.match(result.reason, /preferencia explícita/);
});

test("estimatedValue == eligibilityScore en esta v1 (documentado, no coincidencia)", () => {
  const result = scoreAiVideoEligibility({ id: "s7", visualIntent: "people cooperating and building", durationSec: 5 }, BALANCED);
  assert.equal(result.estimatedValue, result.eligibilityScore);
});

test("score nunca sale de [0,1] con muchas señales opuestas o repetidas", () => {
  const manyHigh = scoreAiVideoEligibility(
    {
      id: "s8",
      visualIntent:
        "walking running building construction digging carrying working gesture gesturing reaching lifting pulling pushing cooperating interacting transforming",
      durationSec: 5,
      motionRequired: true,
    },
    BALANCED,
  );
  assert.ok(manyHigh.eligibilityScore <= 1 && manyHigh.eligibilityScore >= 0);
  const manyLow = scoreAiVideoEligibility(
    { id: "s9", visualIntent: "map document inscription statue photograph architecture ruins carving relief manuscript", durationSec: 5 },
    BALANCED,
  );
  assert.ok(manyLow.eligibilityScore <= 1 && manyLow.eligibilityScore >= 0);
});

test("scoreAiVideoEligibilityBatch procesa una lista en orden y devuelve un resultado por shot", () => {
  const results = scoreAiVideoEligibilityBatch(
    [
      { id: "a", visualIntent: "a map", durationSec: 5, type: "map" },
      { id: "b", visualIntent: "people building together", durationSec: 5 },
    ],
    BALANCED,
  );
  assert.equal(results.length, 2);
  assert.equal(results[0].shotId, "a");
  assert.equal(results[1].shotId, "b");
});

test("mismo input siempre produce el mismo resultado (determinístico, sin aleatoriedad)", () => {
  const input = { id: "det", visualIntent: "people walking and gathering", durationSec: 7 };
  const a = scoreAiVideoEligibility(input, BALANCED);
  const b = scoreAiVideoEligibility(input, BALANCED);
  assert.deepEqual(a, b);
});
