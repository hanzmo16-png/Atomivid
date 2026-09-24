import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCuriosityDemoProject } from "./fixture-demo";
import { assertBeatsHaveMultipleShots, assertShotHolds, cycleShotType } from "./shots";
import { SHOT_TYPES } from "./types";

test("demo project is curiosity mode with multiple shots per beat", () => {
  const project = buildCuriosityDemoProject();
  assert.equal(project.mode, "curiosity_documentary");
  assert.equal(project.spec.width, 1920);
  assert.equal(project.spec.height, 1080);
  assert.equal(project.spec.fps, 30);
  assertBeatsHaveMultipleShots(project.beats, 2);
  const shots = project.beats.flatMap((b) => b.shots);
  assertShotHolds(shots);
  assert.ok(shots.length >= 6);
  assert.ok(project.segments.length >= 2);
  const types = new Set(shots.map((s) => s.type));
  assert.ok(types.size >= 3);
});

test("forbidden model 7 beats = 7 images is not used in P0 demo", () => {
  const project = buildCuriosityDemoProject();
  for (const beat of project.beats) {
    assert.ok(beat.shots.length > 1);
  }
});

test("shot cycle covers every fixture type including stock video", () => {
  // RC Phase 1: SHOT_TYPES ganó "ai_video" (para que resolveShotAsset
  // pueda manejarlo, ver asset-resolver.ts), pero cycleShotType() NUNCA
  // debe producirlo — un shot solo debe ser "ai_video" por asignación
  // EXPLÍCITA (requiere ctx.aiVideo con providerVideo/ledger reales en
  // resolveShotAsset), nunca por el round-robin determinístico que arma
  // storyboards de demo/fixture. Por eso este test ya no compara contra
  // SHOT_TYPES.length (8) sino contra los tipos que el ciclo SÍ cubre.
  const nonCycleTypes: ReturnType<typeof cycleShotType>[] = ["ai_video"];
  const cyclableTypes = SHOT_TYPES.filter((t) => !nonCycleTypes.includes(t));
  const seen = new Set(cyclableTypes.map((_, i) => cycleShotType(i)));
  assert.equal(seen.size, cyclableTypes.length);
  assert.ok(!seen.has("ai_video"), "cycleShotType nunca debe producir ai_video automáticamente");
});
