import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_BENCHMARK_SHOTS,
  ACTIVE_BENCHMARK_ID,
  activeBenchmarkShotToEligibilityInput,
} from "./ai-video-benchmark-v2-active";
import { scoreAiVideoEligibility, AI_VIDEO_SCORE_THRESHOLD } from "./ai-video-eligibility";
import { HISTORICAL_CLASSIFICATIONS } from "./types";

test("el benchmark activo tiene EXACTAMENTE 2 shots (Pillar Transport, Monument/Architecture at Dawn)", () => {
  assert.equal(ACTIVE_BENCHMARK_SHOTS.length, 2);
  const titles = ACTIVE_BENCHMARK_SHOTS.map((s) => s.title).sort();
  assert.deepEqual(titles, ["Monument / Architecture at Dawn", "Pillar Transport"]);
});

test("todos los shots pertenecen al mismo benchmarkId activo", () => {
  for (const shot of ACTIVE_BENCHMARK_SHOTS) {
    assert.equal(shot.benchmarkId, ACTIVE_BENCHMARK_ID);
  }
});

test("cada shot tiene una referenceImageSpec con al menos 4 requiredControls y 16:9 — el status varía según si ya fue aprobada (P2B preparation)", () => {
  for (const shot of ACTIVE_BENCHMARK_SHOTS) {
    assert.ok(["not_generated", "pending_review", "approved"].includes(shot.referenceImageSpec.status));
    assert.ok(shot.referenceImageSpec.requiredControls.length >= 4);
    assert.equal(shot.referenceImageSpec.aspectRatio, "16:9");
  }
});

test("Pillar Transport tiene su imagen de referencia APROBADA (P2B preparation) con metadata completa de aprobación", () => {
  const shot = ACTIVE_BENCHMARK_SHOTS.find((s) => s.shotId === "bench-v2-a-pillar-transport")!;
  assert.equal(shot.referenceImageSpec.status, "approved");
  assert.ok(shot.referenceImageSpec.approval);
  assert.equal(shot.referenceImageSpec.approval?.approvedBy, "Hans");
  assert.equal(shot.referenceImageSpec.approval?.widthPx, 1672);
  assert.equal(shot.referenceImageSpec.approval?.heightPx, 941);
  assert.ok(shot.referenceImageSpec.approval?.checksumSha256.length === 64);
  // historicalClassification NUNCA cambia a real_documented por tener una imagen aprobada — sigue siendo una reconstrucción.
  assert.equal(shot.historicalClassification, "reconstruction");
});

test("Monument/Architecture at Dawn sigue SIN imagen de referencia (not_generated) — la aprobación de Pillar Transport no afecta otros shots", () => {
  const shot = ACTIVE_BENCHMARK_SHOTS.find((s) => s.shotId === "bench-v2-b-monument-architecture-dawn")!;
  assert.equal(shot.referenceImageSpec.status, "not_generated");
  assert.equal(shot.referenceImageSpec.approval, undefined);
});

test("cada shot declara una historicalClassification válida, ninguna real_documented", () => {
  for (const shot of ACTIVE_BENCHMARK_SHOTS) {
    assert.ok((HISTORICAL_CLASSIFICATIONS as readonly string[]).includes(shot.historicalClassification));
    assert.notEqual(shot.historicalClassification, "real_documented");
  }
});

test("el Eligibility Engine SIN modificar recomienda ai_video para ambos shots del benchmark activo", () => {
  for (const shot of ACTIVE_BENCHMARK_SHOTS) {
    const result = scoreAiVideoEligibility(activeBenchmarkShotToEligibilityInput(shot));
    assert.equal(result.recommendedAssetType, shot.expectedEligibility.recommendedAssetType);
    assert.ok(result.eligibilityScore >= AI_VIDEO_SCORE_THRESHOLD);
  }
});

test("cada shot lista evaluationCriteria no vacío", () => {
  for (const shot of ACTIVE_BENCHMARK_SHOTS) {
    assert.ok(shot.evaluationCriteria.length > 0);
  }
});
