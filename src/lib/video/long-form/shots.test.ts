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
  const seen = new Set(SHOT_TYPES.map((_, i) => cycleShotType(i)));
  assert.equal(seen.size, SHOT_TYPES.length);
});
