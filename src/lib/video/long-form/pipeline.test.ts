import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFixtureScript } from "./fixture-pipeline";
import { estimateLongFormCost, assertWithinBudget, DEFAULT_LONG_FORM_BUDGET } from "./cost";
import { planSegments, nextRetryableSegment } from "./segments";
import { rejectTranscriptRewriteIntent, usesBannedOpener } from "./originality";
import { clampTargetDuration } from "./duration";
import { assertBeatsHaveMultipleShots, assertShotHolds } from "./shots";

test("fixture documentary script has required beats and no banned opener", () => {
  const script = buildFixtureScript({
    topic: "Roman street food",
    mode: "curiosity_documentary",
    language: "en",
    targetDurationSec: 10 * 60,
  });
  assert.equal(script.beats[0].type, "hook");
  assert.equal(usesBannedOpener(script.hook), false);
  assert.equal(script.bannedOpenersUsed, false);
  assert.ok(script.beats.some((b) => b.type === "twist"));
  assertBeatsHaveMultipleShots(script.beats, 2);
  assertShotHolds(script.beats.flatMap((b) => b.shots));
  const shotCount = script.beats.reduce((n, b) => n + b.shots.length, 0);
  assert.ok(shotCount > script.beats.length);
});

test("behavior mode does not default to Marcus Aurelius costume", () => {
  const script = buildFixtureScript({
    topic: "explaining yourself at work",
    mode: "behavior_essay",
    language: "en",
    targetDurationSec: 12 * 60,
  });
  const blob = `${script.title}\n${script.hook}\n${script.beats.map((b) => b.narration).join(" ")}`.toLowerCase();
  assert.equal(blob.includes("marcus aurelius"), false);
  assert.equal(blob.includes("sigma"), false);
  assert.equal(script.beats[0].type, "hook");
});

test("duration clamps to mode windows", () => {
  assert.equal(clampTargetDuration("curiosity_documentary", 60), 8 * 60);
  assert.equal(clampTargetDuration("behavior_essay", 99999), 16 * 60);
});

test("segment plan supports partial retry", () => {
  const script = buildFixtureScript({
    topic: "night watches",
    mode: "curiosity_documentary",
    language: "en",
    targetDurationSec: 10 * 60,
  });
  const plans = planSegments(script.beats, 120);
  assert.ok(plans.length >= 2);
  assert.ok(plans.every((p) => p.shotIds.length >= 2));
  plans[0].status = "validated";
  const next = nextRetryableSegment(plans);
  assert.ok(next);
  assert.notEqual(next?.id, plans[0].id);
});

test("cost estimate stays inside default internal budget for fixture", () => {
  const script = buildFixtureScript({
    topic: "limits",
    mode: "behavior_essay",
    language: "en",
    targetDurationSec: 12 * 60,
  });
  const estimate = estimateLongFormCost({ durationSec: 12 * 60, beats: script.beats });
  assertWithinBudget(estimate, DEFAULT_LONG_FORM_BUDGET);
  assert.ok(estimate.usdPerMinute > 0);
  assert.ok(estimate.assetCount > estimate.sceneCount);
});

test("transcript rewrite path is rejected", () => {
  assert.throws(() => rejectTranscriptRewriteIntent({ rewriteRequested: true }));
  assert.throws(() => rejectTranscriptRewriteIntent({ sourceTranscript: "x".repeat(401) }));
});
