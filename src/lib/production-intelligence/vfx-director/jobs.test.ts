import test from "node:test";
import assert from "node:assert/strict";
import { createJob, runTask, reconcileTask, approveStage, replacePlan, memoryJobStore, ownedJob, type DurableExecutor } from "./jobs";
import { parseShotContract } from "../contract";
import { DIRECTOR_VERSION } from "./index";
import { CHECKS } from "./gates";
import { directorActor } from "./access";
import { reviewView } from "./review-view";
const owner = "owner-1";
test("VFX has a separate owner setting without changing Avatar access", () => {
  const user = { id: owner, email: "vfx@example.com", email_confirmed_at: "confirmed" };
  assert.equal(directorActor(user, { VFX_DIRECTOR_ENABLED: "1", VFX_DIRECTOR_OWNER_EMAIL: "vfx@example.com", AVATAR_PREPARATION_OWNER_EMAIL: "avatar@example.com" }), owner);
  assert.throws(() => directorActor({ ...user, email: "avatar@example.com" }, { VFX_DIRECTOR_ENABLED: "1", VFX_DIRECTOR_OWNER_EMAIL: "vfx@example.com", AVATAR_PREPARATION_OWNER_EMAIL: "avatar@example.com" }));
});
const inventory = { proof: { available: true, paid: false, preservesOriginalPixels: true } };
const brief = { projectId: "proof-job", intent: "show transformation", emotion: "surprise", frames: 150, fps: 30, width: 1080, height: 1920, sourceSha256: "a".repeat(64), subjectLock: "original_pixels", budgetUsd: 0 };
const contract = parseShotContract({ shotId: "open", shotClass: "talking_head", narrationIntent: "show transformation", visualIntent: "room to city", motionRequirement: "simple", motionLeverage: "HIGH", riskClass: "HIGH", desiredDuration: 5, maxGeneratedDuration: 0, qualityTier: "hero" });
const plan = { version: DIRECTOR_VERSION, sourceSha256: brief.sourceSha256, contract,
  world: { scaleMeters: 1.8, physics: "terrestrial", light: "measured key", optics: "measured source", continuityIn: "room", continuityOut: "UI" },
  layersFrontToBack: ["person", "plate"], beats: [{ frame: 0, action: "room" }], requiredChecks: ["edges"],
  tasks: [{ stage: "direction" as const, id: "direction", executor: "proof", dependsOn: [], inputAssetIds: ["source"], outputAssetId: "direction-result", instruction: "write proof", acceptance: ["artifact fingerprint"] },
    { stage: "styleframe" as const, id: "look", executor: "proof", dependsOn: ["direction"], inputAssetIds: ["direction-result"], outputAssetId: "look-result", instruction: "import reviewed styleframe", acceptance: ["artifact fingerprint"] }] };
function executor(fn?: () => Promise<void>): DurableExecutor { return { capability: inventory.proof, allowedStages: ["direction", "styleframe"], async run(task) { await fn?.(); return { assetId: task.outputAssetId, sha256: "b".repeat(64), checks: [{ name: "file", pass: true, evidence: "test proof" }] }; } }; }
async function initialize() { const store = memoryJobStore(); await createJob(store, owner, owner, brief, plan, inventory, ["source"]); return store; }
async function approveDirection(store: ReturnType<typeof memoryJobStore>) { const job = await ownedJob(store, brief.projectId, owner); return approveStage(store, job.id, owner, { stage: "direction", planHash: job.planHash, artifactSha256: job.artifacts.direction!, approved: true, checks: CHECKS.direction.map(name => ({ name, pass: true, evidence: "test review" })) }); }
test("second click shares job and concurrent workers execute once", async () => {
  const store = await initialize(); assert.equal((await createJob(store, owner, owner, brief, plan, inventory, ["source"])).revision, 0);
  let calls = 0; let release!: () => void; const hold = new Promise<void>(r => { release = r; });
  const ex = executor(async () => { calls++; await hold; });
  const first = runTask(store, brief.projectId, owner, { proof: ex });
  await new Promise(r => setTimeout(r, 10)); const second = await runTask(store, brief.projectId, owner, { proof: ex });
  assert.equal(second.executed, false); release(); await first; assert.equal(calls, 1);
});
test("unapproved direction stops worker before styleframe executor", async () => {
  const store = await initialize(); let calls = 0; const ex = executor(async () => { calls++; });
  await runTask(store, brief.projectId, owner, { proof: ex });
  const result = await runTask(store, brief.projectId, owner, { proof: ex });
  assert.equal(result.job.status, "BLOCKED"); assert.equal(calls, 1);
});
test("failed task resumes same plan at failed task, without repeating completed work", async () => {
  const store = await initialize(); const calls: string[] = [];
  const ex = executor(); ex.run = async task => { calls.push(task.id); if (task.id === "look" && calls.filter(x => x === "look").length === 1) throw new Error("bad edge"); return { assetId: task.outputAssetId, sha256: "b".repeat(64), checks: [{ name: "edge", pass: true, evidence: "fixture" }] }; };
  await runTask(store, brief.projectId, owner, { proof: ex }); await approveDirection(store);
  const failed = await runTask(store, brief.projectId, owner, { proof: ex }); assert.equal(failed.job.status, "FAILED");
  const resumed = await runTask(store, brief.projectId, owner, { proof: ex });
  assert.equal(resumed.executed, true); assert.equal(resumed.job.planHash, failed.job.planHash); assert.deepEqual(calls, ["direction", "look", "look"]);
});
test("plan replacement clears approvals and outputs; stale review cannot approve", async () => {
  const store = await initialize(); await runTask(store, brief.projectId, owner, { proof: executor() }); const approved = await approveDirection(store);
  const changed = await replacePlan(store, brief.projectId, owner, { ...plan, world: { ...plan.world, continuityOut: "new cut" } });
  assert.notEqual(changed.planHash, approved.planHash); assert.deepEqual(changed.approvals, []); assert.deepEqual(changed.results, {});
  await assert.rejects(approveStage(store, changed.id, owner, { stage: "direction", planHash: approved.planHash, artifactSha256: "b".repeat(64), approved: true, checks: [] }));
});
test("rejection persists and blocks worker; other account cannot read, execute or approve", async () => {
  const store = await initialize(); await runTask(store, brief.projectId, owner, { proof: executor() }); const approved = await approveDirection(store);
  await approveStage(store, approved.id, owner, { stage: "direction", planHash: approved.planHash, artifactSha256: approved.artifacts.direction!, approved: false, checks: [{ name: "silent-readability", pass: false, evidence: "action unclear" }] });
  assert.equal((await runTask(store, approved.id, owner, { proof: executor() })).job.status, "BLOCKED");
  assert.equal(reviewView(await ownedJob(store, approved.id, owner))[0].canApprove, false);
  await assert.rejects(ownedJob(store, approved.id, "intruder")); await assert.rejects(runTask(store, approved.id, "intruder", { proof: executor() }));
  await assert.rejects(approveStage(store, approved.id, "intruder", { stage: "direction", planHash: approved.planHash, artifactSha256: "b".repeat(64), approved: true, checks: [] }));
});
test("interrupted RUNNING state is not blindly re-executed", async () => {
  const store = await initialize(); const job = (await store.get(brief.projectId))!;
  await store.cas({ ...job, revision: 1, status: "RUNNING", activeTask: "direction" }, 0);
  let calls = 0; assert.equal((await runTask(store, brief.projectId, owner, { proof: executor(async () => { calls++; }) })).executed, false); assert.equal(calls, 0);
});
test("owner access is disabled by default and requires verified owner email", () => {
  const user = { id: owner, email: "owner@example.test", email_confirmed_at: "now" };
  assert.throws(() => directorActor(user, {}));
  const env = { VFX_DIRECTOR_ENABLED: "1", AVATAR_PREPARATION_OWNER_EMAIL: user.email };
  assert.equal(directorActor(user, env), owner); assert.throws(() => directorActor({ ...user, email: "other@example.test" }, env));
});

test("interrupted task recovers existing output without invoking its executor again", async () => {
  const store = await initialize(); const job = (await store.get(brief.projectId))!;
  await store.cas({ ...job, revision: 1, status: "RUNNING", activeTask: "direction" }, 0);
  const ex = executor(async () => { throw new Error("must not run"); });
  ex.recover = async task => ({ assetId: task.outputAssetId, sha256: "b".repeat(64), checks: [{ name: "hash", pass: true, evidence: "existing output" }] });
  const recovered = await reconcileTask(store, brief.projectId, owner, { proof: ex });
  assert.equal(recovered.status, "READY"); assert.equal(recovered.planHash, job.planHash); assert.equal(recovered.results.direction.assetId, "direction-result");
});

test("Preview rollout permits only configured verified owner; production stays off", () => {
  const user = { id: owner, email: "owner@example.test", email_confirmed_at: "now" };
  const preview = { VERCEL_ENV: "preview", AVATAR_PREPARATION_OWNER_EMAIL: user.email };
  assert.equal(directorActor(user, preview), owner);
  assert.throws(() => directorActor({ ...user, email: "intruder@example.test" }, preview));
  assert.throws(() => directorActor(user, { ...preview, VERCEL_ENV: "production" }));
  assert.throws(() => directorActor(user, { ...preview, VFX_DIRECTOR_ENABLED: "0" }));
});
