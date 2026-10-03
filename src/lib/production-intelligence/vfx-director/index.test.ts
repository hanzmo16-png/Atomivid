import test from "node:test";
import assert from "node:assert/strict";
import { compilePlan, execute, review, DIRECTOR_VERSION } from "./index";
import { parseShotContract } from "../contract";
const brief = { projectId: "review-opening", intent: "environment transform", emotion: "surprise", frames: 240, fps: 30, width: 1080, height: 1920, sourceSha256: "a".repeat(64), subjectLock: "original_pixels", budgetUsd: 0 };
const plan = { version: DIRECTOR_VERSION, sourceSha256: brief.sourceSha256,
  contract: parseShotContract({ shotId: "opening", shotClass: "talking_head", narrationIntent: "show capability", visualIntent: "room to city", motionRequirement: "simple", motionLeverage: "HIGH", riskClass: "HIGH", desiredDuration: 8, maxGeneratedDuration: 0, qualityTier: "hero" }),
  world: { scaleMeters: 1.8, physics: "earth gravity", light: "match measured source", optics: "measure source lens", continuityIn: "room", continuityOut: "city" }, layersFrontToBack: ["subject", "plate"], beats: [{ frame: 0, action: "room" }, { frame: 90, action: "city" }],
  tasks: [{ id: "composite", executor: "fixture", dependsOn: [], inputAssetIds: ["source"], outputAssetId: "review", instruction: "Preserve original subject pixels; replace background only", acceptance: ["subject unchanged"] }], requiredChecks: ["subject-lock", "plate-resolution"] };
const inventory = { fixture: { available: true, paid: false, preservesOriginalPixels: true } };
test("deterministic preflight reuses PI reservation without spend", () => {
  const a = compilePlan(brief, plan, inventory, ["source"]);
  assert.equal(a.executable, true); assert.equal(a.reservation.reservedUsd, 0);
  assert.equal(a.planHash, compilePlan(brief, plan, inventory, ["source"]).planHash);
});
test("missing capability, paid routing and identity mismatch block", () => {
  assert.equal(compilePlan(brief, plan, {}, ["source"]).executable, false);
  assert.equal(compilePlan(brief, plan, { fixture: { ...inventory.fixture, paid: true } }, ["source"]).executable, false);
  assert.equal(compilePlan(brief, plan, { fixture: { ...inventory.fixture, preservesOriginalPixels: false } }, ["source"]).executable, false);
});
test("dependencies, assets, source and frame bounds are enforced", () => {
  for (const changed of [
    { ...plan, sourceSha256: "b".repeat(64) },
    { ...plan, beats: [{ frame: 240, action: "too late" }] },
    { ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ["unknown"] }] },
    { ...plan, tasks: [{ ...plan.tasks[0], outputAssetId: "source" }] },
  ]) assert.equal(compilePlan(brief, changed, inventory, ["source"]).executable, false);
  assert.equal(compilePlan(brief, plan, inventory, []).executable, false);
});
test("all blockers remain visible and human approval cannot bypass checks", () => {
  const compiled = compilePlan(brief, plan, inventory, ["source"]);
  assert.equal(review(compiled.plan, [], true).approved, false);
  const checks = plan.requiredChecks.map(name => ({ name, pass: true, evidence: "fixture evidence only" }));
  assert.equal(review(compiled.plan, checks, false).approved, false);
  assert.equal(review(compiled.plan, checks, true).approved, true);
  assert.equal(review(compiled.plan, [...checks, { name: "edges", pass: false, evidence: "halo" }], true).approved, false);
});
test("execution is host-controlled; failed QA stops dependent work", async () => {
  let calls = 0;
  const executors = { fixture: { capability: inventory.fixture, run: async () => { calls++; return { assetId: "review", checks: [{ name: "fixture", pass: true, evidence: "test-only output" }] }; } } };
  assert.equal((await execute(brief, plan, executors, ["source"])).status, "REVIEW_REQUIRED");
  assert.equal(calls, 1);
  await assert.rejects(execute(brief, plan, {}, ["source"]));
  assert.equal(calls, 1);
  await assert.rejects(execute(brief, plan, { fixture: { capability: inventory.fixture, run: async () => ({ assetId: "review", checks: [] }) } }, ["source"]));
});
