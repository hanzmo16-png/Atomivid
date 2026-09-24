import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GOBEKLI_TEPE_BENCHMARK_MANIFEST,
  GOBEKLI_TEPE_BENCHMARK_SHOTS,
  GOBEKLI_TEPE_BENCHMARK_ID,
  benchmarkShotToEligibilityInput,
} from "./ai-video-benchmark-manifest";
import { scoreAiVideoEligibility, AI_VIDEO_SCORE_THRESHOLD } from "./ai-video-eligibility";
import { HISTORICAL_CLASSIFICATIONS } from "./types";

test("el manifest tiene exactamente 5 shots, todos con el mismo benchmarkId", () => {
  assert.equal(GOBEKLI_TEPE_BENCHMARK_MANIFEST.shots.length, 5);
  for (const shot of GOBEKLI_TEPE_BENCHMARK_MANIFEST.shots) {
    assert.equal(shot.benchmarkId, GOBEKLI_TEPE_BENCHMARK_ID);
  }
});

test("todos los shotId son únicos", () => {
  const ids = GOBEKLI_TEPE_BENCHMARK_SHOTS.map((s) => s.shotId);
  assert.equal(new Set(ids).size, ids.length);
});

test("los 5 shots esperados (A-E) están presentes por título", () => {
  const titles = GOBEKLI_TEPE_BENCHMARK_SHOTS.map((s) => s.title).sort();
  assert.deepEqual(titles, ["Construction", "Hero Shot", "Monument at Dawn", "Pillar Transport", "Stone Carving"].sort());
});

test("cada shot declara una historicalClassification válida — ninguno es 'real_documented' (todos son recreaciones IA)", () => {
  for (const shot of GOBEKLI_TEPE_BENCHMARK_SHOTS) {
    assert.ok((HISTORICAL_CLASSIFICATIONS as readonly string[]).includes(shot.historicalClassification));
    assert.notEqual(shot.historicalClassification, "real_documented");
  }
});

test("cada shot declara aspectRatio 16:9, duración positiva, y al menos una negative constraint", () => {
  for (const shot of GOBEKLI_TEPE_BENCHMARK_SHOTS) {
    assert.equal(shot.aspectRatio, "16:9");
    assert.ok(shot.durationSec > 0);
    assert.ok(shot.negativeConstraints.length > 0);
    assert.ok(shot.evaluationCriteria.length > 0);
  }
});

test("el Eligibility Engine SIN modificar recomienda ai_video para los 5 shots del benchmark, por encima de expectedEligibility.minScore", () => {
  for (const shot of GOBEKLI_TEPE_BENCHMARK_SHOTS) {
    const result = scoreAiVideoEligibility(benchmarkShotToEligibilityInput(shot));
    assert.equal(
      result.recommendedAssetType,
      shot.expectedEligibility.recommendedAssetType,
      `${shot.shotId}: esperado ${shot.expectedEligibility.recommendedAssetType}, obtenido ${result.recommendedAssetType} (score ${result.eligibilityScore})`,
    );
    assert.ok(
      result.eligibilityScore >= shot.expectedEligibility.minScore,
      `${shot.shotId}: score ${result.eligibilityScore} por debajo del mínimo esperado ${shot.expectedEligibility.minScore}`,
    );
    assert.ok(result.eligibilityScore >= AI_VIDEO_SCORE_THRESHOLD);
  }
});

test("benchmarkShotToEligibilityInput preserva id/visualIntent/durationSec y fuerza motionRequired=true", () => {
  const shot = GOBEKLI_TEPE_BENCHMARK_SHOTS[0];
  const input = benchmarkShotToEligibilityInput(shot);
  assert.equal(input.id, shot.shotId);
  assert.equal(input.visualIntent, shot.visualIntent);
  assert.equal(input.durationSec, shot.durationSec);
  assert.equal(input.motionRequired, true);
});

test("el manifest es determinístico (mismo objeto, mismo contenido en llamadas repetidas)", () => {
  const a = GOBEKLI_TEPE_BENCHMARK_SHOTS.map((s) => s.shotId);
  const b = GOBEKLI_TEPE_BENCHMARK_SHOTS.map((s) => s.shotId);
  assert.deepEqual(a, b);
});
