import test from "node:test";
import assert from "node:assert/strict";
import { compilePlan, DIRECTOR_VERSION, type Inventory, type Plan } from "./index";
import { createJob, runTask, approveStage, replacePlan, memoryJobStore, jobGates, environmentHash, type DurableExecutor } from "./jobs";
import { CHECKS } from "./gates";
import { parseShotContract } from "../contract";
import { vfx002bExecutor } from "./compositor";
const owner = "owner";
const requirements = [
  { id: "nyc", kind: "city" as const, lighting: "night_practical" as const },
  { id: "beach", kind: "beach" as const, lighting: "daylight_soft" as const },
  { id: "moon", kind: "moon" as const, lighting: "sun_hard" as const },
];
const brief = { projectId: "multi-world", intent: "idea changes the world", emotion: "wonder", frames: 150, fps: 30, width: 1080, height: 1920,
  sourceSha256: "a".repeat(64), subjectLock: "identity_with_relight" as const, budgetUsd: 0, environments: requirements };
const stages = ["direction", "styleframe", "motion", "integration"] as const;
const plan: Plan = {
  version: DIRECTOR_VERSION, sourceSha256: brief.sourceSha256,
  contract: parseShotContract({ shotId: "open", shotClass: "talking_head", narrationIntent: brief.intent, visualIntent: "room to three worlds", motionRequirement: "simple", motionLeverage: "HIGH", riskClass: "HIGH", desiredDuration: 5, maxGeneratedDuration: 0, qualityTier: "hero" }),
  world: { scaleMeters: 1.8, physics: "preserve subject stance", light: "per-environment key", optics: "measured camera", continuityIn: "apartment", continuityOut: "app" },
  layersFrontToBack: ["person", "plate"], beats: [{ frame: 0, action: "room" }], requiredChecks: ["edges"],
  environments: requirements.map((env, i) => ({ ...env, startFrame: i * 50, endFrame: (i + 1) * 50, materialAssetId: `${env.id}-plate`, materialSha256: String(i + 1).repeat(64), light: `${env.lighting}: measured key and fill`, continuityIn: "scan enters", continuityOut: "scan exits" })),
  tasks: [...requirements.flatMap(env => stages.map((stage, i) => ({ stage, environmentId: env.id, id: `${env.id}-${stage}`, executor: "proof",
    dependsOn: i ? [`${env.id}-${stages[i - 1]}`] : [], inputAssetIds: ["source", `${env.id}-plate`, ...(i ? [`${env.id}-${stages[i - 1]}-out`] : [])],
    outputAssetId: `${env.id}-${stage}-out`, instruction: `measure ${stage} for ${env.id}`, acceptance: ["measured artifact"] }))),
    { stage: "master", id: "master", executor: "proof", dependsOn: requirements.map(e => `${e.id}-integration`), inputAssetIds: requirements.map(e => `${e.id}-integration-out`), outputAssetId: "master-out", instruction: "assemble all reviewed environments", acceptance: ["full sequence"] }],
};
const inventory: Inventory = { proof: { available: true, paid: false, preservesOriginalPixels: false } };
const assets = ["source", ...requirements.map(e => `${e.id}-plate`)];
function executor(calls: string[] = []): DurableExecutor {
  return { capability: inventory.proof, allowedStages: [...stages, "master"], async run(task) {
    calls.push(task.id); return { assetId: task.outputAssetId, sha256: "b".repeat(64), checks: [{ name: "fingerprint", pass: true, evidence: "fixture measured output" }] };
  } };
}
async function reviewedWorlds() {
  const store = memoryJobStore(); await createJob(store, owner, owner, brief, plan, inventory, assets);
  const ex = executor();
  for (const env of requirements) for (const stage of stages) {
    const { job, executed } = await runTask(store, brief.projectId, owner, { proof: ex }); assert.ok(executed);
    const context = jobGates(job, env.id);
    await approveStage(store, job.id, owner, { environmentId: env.id, stage, planHash: context.planHash, artifactSha256: context.artifacts[stage]!, approved: true,
      checks: CHECKS[stage].map(name => ({ name, pass: true, evidence: "fixture review" })) });
  }
  return store;
}
test("planner cannot omit requested worlds, light or mandatory stage proofs", () => {
  assert.ok(compilePlan(brief, plan, inventory, assets).executable);
  assert.ok(!compilePlan(brief, { ...plan, environments: plan.environments.slice(0, 1) }, inventory, assets).executable);
  assert.ok(!compilePlan(brief, { ...plan, tasks: plan.tasks.map(t => t.stage === "master" ? { ...t, inputAssetIds: ["nyc-integration-out"] } : t) }, inventory, assets).executable);
  assert.ok(!compilePlan(brief, { ...plan, tasks: plan.tasks.map(t => t.id === "beach-motion" ? { ...t, dependsOn: [], inputAssetIds: ["source", "beach-plate"] } : t) }, inventory, assets).executable);
  assert.ok(!compilePlan(brief, { ...plan, tasks: plan.tasks.filter(t => t.id !== "beach-styleframe") }, inventory, assets).executable);
  assert.ok(!compilePlan(brief, { ...plan, environments: plan.environments.map(e => e.id === "moon" ? { ...e, lighting: "night_practical" } : e) }, inventory, assets).executable);
});
test("night-only capability rejects beach and moon before executor is invoked", async () => {
  const store = memoryJobStore(); await createJob(store, owner, owner, brief, plan, inventory, assets);
  const calls: string[] = []; const ex = executor(calls);
  ex.capability = { ...ex.capability, environments: [{ kind: "city", lighting: "night_practical" }] };
  const compiled = compilePlan(brief, plan, { proof: ex.capability }, assets);
  assert.ok(compiled.errors.some(e => e.includes("beach") && e.includes("unsupported")));
  assert.ok(compiled.errors.some(e => e.includes("moon") && e.includes("unsupported")));
  assert.equal((await runTask(store, brief.projectId, owner, { proof: ex })).job.status, "BLOCKED"); assert.deepEqual(calls, []);
});
test("beach material correction invalidates only beach and master, retaining NYC and Moon", async () => {
  const store = await reviewedWorlds(); const before = (await store.get(brief.projectId))!;
  await runTask(store, before.id, owner, { proof: executor() });
  const changed = await replacePlan(store, before.id, owner, { ...plan, environments: plan.environments.map(e => e.id === "beach" ? { ...e, materialSha256: "f".repeat(64) } : e) });
  assert.equal(environmentHash(changed, "nyc"), environmentHash(before, "nyc"));
  assert.equal(environmentHash(changed, "moon"), environmentHash(before, "moon"));
  assert.notEqual(environmentHash(changed, "beach"), environmentHash(before, "beach"));
  assert.ok(changed.results["nyc-integration"]); assert.ok(changed.results["moon-integration"]);
  assert.equal(changed.results["beach-direction"], undefined); assert.equal(changed.results.master, undefined);
  assert.equal(changed.approvals.length, 8); assert.equal(changed.environmentArtifacts?.beach, undefined);
  await assert.rejects(approveStage(store, before.id, owner, { environmentId: "beach", stage: "direction", planHash: environmentHash(before, "beach"), artifactSha256: "b".repeat(64), approved: true, checks: [] }));
  const calls: string[] = []; await runTask(store, before.id, owner, { proof: executor(calls) }); assert.deepEqual(calls, ["beach-direction"]);
});
test("same-plan replacement is a no-op and preserves every review", async () => {
  const store = await reviewedWorlds(); const before = (await store.get(brief.projectId))!;
  assert.deepEqual(await replacePlan(store, before.id, owner, plan), before);
});
test("one rejected integration blocks master even when other worlds are approved", async () => {
  const store = await reviewedWorlds(); const job = (await store.get(brief.projectId))!; const ctx = jobGates(job, "beach");
  await approveStage(store, job.id, owner, { environmentId: "beach", stage: "integration", planHash: ctx.planHash, artifactSha256: ctx.artifacts.integration!, approved: false, checks: [{ name: "lighting", pass: false, evidence: "key direction mismatch" }] });
  const calls: string[] = []; const result = await runTask(store, job.id, owner, { proof: executor(calls) });
  assert.equal(result.job.status, "BLOCKED"); assert.deepEqual(calls, []);
});
test("reviews cannot borrow another world's hash or reviewer identity", async () => {
  const store = await reviewedWorlds(); const job = (await store.get(brief.projectId))!;
  await assert.rejects(approveStage(store, job.id, owner, { environmentId: "beach", stage: "integration", planHash: environmentHash(job, "nyc"), artifactSha256: "b".repeat(64), approved: true, checks: [] }));
  await assert.rejects(approveStage(store, job.id, "intruder", { environmentId: "beach", stage: "integration", planHash: environmentHash(job, "beach"), artifactSha256: "b".repeat(64), approved: true, checks: [] }));
});
test("legacy compositor refuses an unsupported world before even reading local files", async () => {
  const ex = vfx002bExecutor({ source: "/missing", plate: "/missing", model: "/missing", root: "/missing", script: "/missing" });
  await assert.rejects(ex.run(plan.tasks[7], brief, "fixture", plan.environments[1]), /VFX002B_ENVIRONMENT_UNSUPPORTED/);
  assert.equal(ex.capability.fullShotOnly, true);
});

test("selected Moon registration is independent but cannot bypass its reviews or dependencies", async () => {
 const store=memoryJobStore();await createJob(store,owner,owner,brief,plan,inventory,assets);
 const calls:string[]=[];const ex=executor(calls);
 assert.equal((await runTask(store,brief.projectId,owner,{proof:ex},"moon-styleframe")).executed,false);
 const r=await runTask(store,brief.projectId,owner,{proof:ex},"moon-direction");assert.ok(r.executed);
 const c=jobGates(r.job,"moon");
 await approveStage(store,r.job.id,owner,{environmentId:"moon",stage:"direction",planHash:c.planHash,artifactSha256:c.artifacts.direction!,approved:true,checks:CHECKS.direction.map(name=>({name,pass:true,evidence:"fixture owner review"}))});
 assert.ok((await runTask(store,brief.projectId,owner,{proof:ex},"moon-styleframe")).executed);
 assert.equal((await runTask(store,brief.projectId,owner,{proof:ex},"master")).executed,false);
 assert.equal((await runTask(store,brief.projectId,owner,{proof:ex},"moon-styleframe")).executed,false);
 assert.deepEqual(calls,["moon-direction","moon-styleframe"]);
 await assert.rejects(runTask(store,brief.projectId,owner,{proof:ex},"nonexistent"),/TASK_UNKNOWN/);
});
