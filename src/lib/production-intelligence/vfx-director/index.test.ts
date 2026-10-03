import test from "node:test";
import assert from "node:assert/strict";
import { compilePlan, execute, review, direct, assertDelivery, DIRECTOR_VERSION } from "./index";
import { parseShotContract } from "../contract";
const brief = { projectId: "review-opening", intent: "environment transform", emotion: "surprise", frames: 240, fps: 30, width: 1080, height: 1920, sourceSha256: "a".repeat(64), subjectLock: "original_pixels", budgetUsd: 0 };
const plan = { version: DIRECTOR_VERSION, sourceSha256: brief.sourceSha256,
  contract: parseShotContract({ shotId: "opening", shotClass: "talking_head", narrationIntent: "show capability", visualIntent: "room to city", motionRequirement: "simple", motionLeverage: "HIGH", riskClass: "HIGH", desiredDuration: 8, maxGeneratedDuration: 0, qualityTier: "hero" }),
  world: { scaleMeters: 1.8, physics: "earth gravity", light: "match measured source", optics: "measure source lens", continuityIn: "room", continuityOut: "city" }, layersFrontToBack: ["subject", "plate"], beats: [{ frame: 0, action: "room" }, { frame: 90, action: "city" }],
  tasks: [{ stage: "preview", id: "composite", executor: "fixture", dependsOn: [], inputAssetIds: ["source"], outputAssetId: "review", instruction: "Preserve original subject pixels; replace background only", acceptance: ["subject unchanged"] }], requiredChecks: ["subject-lock", "plate-resolution"] };
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
  const executors = { fixture: { capability: inventory.fixture, allowedStages: ["preview" as const], run: async () => { calls++; return { assetId: "review", checks: [{ name: "fixture", pass: true, evidence: "test-only output" }] }; } } };
  assert.equal((await execute(brief, plan, executors, ["source"])).status, "REVIEW_REQUIRED");
  assert.equal(calls, 1);
  await assert.rejects(execute(brief, plan, {}, ["source"]));
  assert.equal(calls, 1);
  await assert.rejects(execute(brief, plan, { fixture: { capability: inventory.fixture, allowedStages: ["preview" as const], run: async () => ({ assetId: "review", checks: [] }) } }, ["source"]));
});

import { CHECKS, STAGES, assertBeforeTask, type GateContext } from "./gates";
function evidence(): GateContext {
  return { planHash: "plan-a", artifacts: Object.fromEntries(STAGES.map(s => [s, "a".repeat(64)])), approvals: STAGES.map(stage => ({ stage, planHash: "plan-a", artifactSha256: "a".repeat(64), reviewerId: "human-1", approved: true, checks: CHECKS[stage].map(name => ({ name, pass: true, evidence: "review frame 42" })) })) };
}
test("director can refuse or request material without executing", async () => {
  for (const response of [{ status: "REJECTED", reason: "pose incompatible", alternative: "record full body" }, { status: "NEEDS_MATERIAL", reason: "no ground", requiredMaterial: ["full body source"] }]) {
    const result = await direct(brief, inventory, ["source"], async () => response);
    assert.equal(result.executable, false);
  }
  await assert.rejects(direct(brief, inventory, ["source"], async () => ({ status: "REJECTED", reason: " ", alternative: "x" })));
});
test("final composition needs direction, look, motion and integration approval", () => {
  const context = evidence(); assert.doesNotThrow(() => assertBeforeTask("master", context));
  for (const stage of STAGES.slice(0, -1)) {
    assert.throws(() => assertBeforeTask("master", { ...context, approvals: context.approvals.filter(a => a.stage !== stage) }));
  }
  assert.throws(() => assertDelivery({ ...context, approvals: context.approvals.filter(a => a.stage !== "master") }));
  assert.doesNotThrow(() => assertDelivery(context));
});
test("stale frames, changed plans, failed borders and late rejection invalidate approval", () => {
  const context = evidence();
  assert.throws(() => assertDelivery({ ...context, planHash: "changed" }));
  assert.throws(() => assertDelivery({ ...context, artifacts: { ...context.artifacts, styleframe: "b".repeat(64) } }));
  const failed = evidence(); failed.approvals[3].checks[0].pass = false;
  assert.throws(() => assertDelivery(failed));
  const rejected = evidence(); rejected.approvals.push({ ...rejected.approvals[3], approved: false });
  assert.throws(() => assertDelivery(rejected));
});
test("planner cannot label final compositor as preview to bypass gates", async () => {
  let calls = 0;
  await assert.rejects(execute(brief, plan, { fixture: { capability: inventory.fixture, allowedStages: ["master"], run: async () => { calls++; return { assetId: "review", checks: [] }; } } }, ["source"]));
  assert.equal(calls, 0);
});
