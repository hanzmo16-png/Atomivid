import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJob, memoryJobStore, ownedJob, runTask, approveStage, type JobStore } from "./jobs";
import { memoryLedgerStore, type PaidOperation } from "../ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { parseShotContract } from "../contract";
import { DIRECTOR_VERSION } from "./index";
import { CHECKS } from "./gates";
import { executionConfig, requestExecution, resolveDispatch, claimDispatch, executionView, nextPendingTask, ExecuteRequestSchema, ResolveDispatchRequestSchema,
  DISPATCH_METHOD, QUEUE_GRACE_MS, type DispatchLedger, type ExecutionDeps, type ExecutionConfig } from "./execution";
import { runDispatch, type RunnerDeps } from "./execution-runner";
import { executionProfile, materialize, profileExecutors, stagedArtifactPath, type ExecutionProfile } from "./execution-profiles";
import { dispatchExecution, executionRuns } from "./execution-github";

const owner = "owner-1", other = "intruder";
const COMMIT = "c".repeat(40), REF = "codex/vfx-sequence-compositor";
const capability = { available: true, paid: false as const, preservesOriginalPixels: true, recipeVersion: "artifact-registry/test-1" };
const brief = { projectId: "exec-job", intent: "three worlds", emotion: "wonder", frames: 150, fps: 30, width: 1080, height: 1920, sourceSha256: "a".repeat(64), subjectLock: "original_pixels", budgetUsd: 0 };
const contract = parseShotContract({ shotId: "open", shotClass: "talking_head", narrationIntent: "x", visualIntent: "room to city", motionRequirement: "simple", motionLeverage: "HIGH", riskClass: "HIGH", desiredDuration: 5, maxGeneratedDuration: 0, qualityTier: "hero" });
const plan = { version: DIRECTOR_VERSION, sourceSha256: brief.sourceSha256, contract,
  world: { scaleMeters: 1.8, physics: "terrestrial", light: "key", optics: "source", continuityIn: "room", continuityOut: "UI" },
  layersFrontToBack: ["person", "plate"], beats: [{ frame: 0, action: "room" }], requiredChecks: ["edges"],
  tasks: [{ stage: "direction" as const, id: "direction", executor: "artifact-registry", dependsOn: [], inputAssetIds: ["source"], outputAssetId: "direction-out", instruction: "register", acceptance: ["fingerprint"] },
    { stage: "styleframe" as const, id: "look", executor: "artifact-registry", dependsOn: ["direction"], inputAssetIds: ["direction-out"], outputAssetId: "look-out", instruction: "register", acceptance: ["fingerprint"] }] };
const enabled: ExecutionConfig = { enabled: true, token: "t", repo: "o/r", ref: REF, commit: COMMIT };
const profile: ExecutionProfile = { jobId: brief.projectId, executors: { "artifact-registry": { kind: "stored-artifact", capability, stages: ["direction", "styleframe"] } } };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function dispatchLedger(): DispatchLedger & ReturnType<typeof memoryLedgerStore> {
  const base = memoryLedgerStore();
  return Object.assign(base, { async list(jobId: string) { return [...base.ops.values()].filter(o => o.projectId === jobId).map(o => ({ ...o })); } });
}
async function setup() {
  const jobs = memoryJobStore();
  await createJob(jobs, owner, owner, brief, plan, { "artifact-registry": capability }, ["source"]);
  const ledger = dispatchLedger();
  const results = memoryResultStore();
  let clock = Date.parse("2026-10-04T12:00:00Z");
  const calls: string[] = [];
  const deps: ExecutionDeps = { jobs, ledger, config: enabled, now: () => new Date(clock),
    dispatch: async (_c, key) => { calls.push(key); assert.equal((await ledger.get(key))?.status, "RESERVED", "ledger row must exist before the network call"); return "accepted"; },
    runs: async () => [] };
  const runner: RunnerDeps = { ledger, jobs, now: () => new Date(clock), owner: async id => ({ id, email_confirmed_at: "2026-01-01" }),
    profile: id => id === profile.jobId ? profile : null, build: (p, current) => profileExecutors(p, { results, currentJob: current }) };
  return { jobs, ledger, results, deps, runner, calls, advance: (ms: number) => { clock += ms; } };
}
async function stage(results: ReturnType<typeof memoryResultStore>, taskId: string, assetId: string, body = `artifact ${taskId}`) {
  const bytes = Buffer.from(body); const assetPath = `${brief.projectId}/staged/${taskId}.bin`;
  await results.putBytes(assetPath, bytes, "application/octet-stream");
  await results.putJson(stagedArtifactPath(brief.projectId, taskId), { jobId: brief.projectId, taskId, assetId, assetPath, sha256: sha(bytes), bytes: bytes.length, evidence: "operator staged measured artifact" });
  return sha(bytes);
}
const request = async (deps: ExecutionDeps, jobs: JobStore, extra: Partial<{ actorId: string; mode: "step" | "reconcile"; revision: number }> = {}) => {
  const job = await ownedJob(jobs, brief.projectId, owner);
  return requestExecution(deps, { id: job.id, actorId: owner, mode: "step", revision: job.revision, planHash: job.planHash, ...extra });
};
const runnerId = { commit: COMMIT, ref: REF, runId: "101" };

test("environment gates: off by default outside preview, production needs explicit flag, credentials and deployed commit required", () => {
  const full = { GH_WORKER_TOKEN: "t", GH_WORKER_REPO: "o/r", VERCEL_GIT_COMMIT_REF: REF, VERCEL_GIT_COMMIT_SHA: COMMIT };
  assert.equal(executionConfig({ ...full }).enabled, false);
  assert.equal(executionConfig({ ...full, VERCEL_ENV: "preview" }).enabled, true);
  assert.equal(executionConfig({ ...full, VERCEL_ENV: "preview", VFX_EXECUTION_ENABLED: "0" }).enabled, false);
  assert.equal(executionConfig({ ...full, VERCEL_ENV: "production", VFX_EXECUTION_ENABLED: "1" }).enabled, false);
  assert.equal(executionConfig({ ...full, VERCEL_ENV: "production", VFX_EXECUTION_ENABLED: "1", VFX_EXECUTION_PRODUCTION: "1" }).enabled, true);
  assert.equal(executionConfig({ ...full, VERCEL_ENV: "preview", GH_WORKER_TOKEN: "" }).enabled, false);
  assert.equal(executionConfig({ ...full, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: undefined }).enabled, false);
  assert.equal(executionConfig({ ...full, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "../main" }).enabled, false);
});

test("browser vocabulary is strict: executors, paths, prices or manifests are rejected", () => {
  const job = { action: "execute", id: "exec-job", mode: "step", revision: 3, planHash: "h" };
  assert.equal(ExecuteRequestSchema.safeParse(job).success, true);
  for (const extra of [{ executors: { x: { kind: "vfx002b", script: "/bin/sh" } } }, { manifest: {} }, { path: "/etc/passwd" }, { priceUsd: 0 }, { ref: "main" }, { commit: COMMIT }])
    assert.equal(ExecuteRequestSchema.safeParse({ ...job, ...extra }).success, false, JSON.stringify(extra));
  assert.equal(ExecuteRequestSchema.safeParse({ ...job, mode: "rerun" }).success, false);
  assert.equal(ResolveDispatchRequestSchema.safeParse({ action: "resolve-dispatch", id: "exec-job", key: "k", force: true }).success, false);
});

test("ledger row is written before dispatch; a second concurrent request cannot dispatch", async () => {
  const { deps, jobs, calls, ledger } = await setup();
  const outcomes = await Promise.allSettled([request(deps, jobs), request(deps, jobs)]);
  assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
  assert.equal(calls.length, 1);
  const rows = [...ledger.ops.values()];
  assert.equal(rows.length, 1); assert.equal(rows[0].status, "SUBMITTED"); assert.equal(rows[0].reservedUsd, 0); assert.equal(rows[0].method, DISPATCH_METHOD);
  await assert.rejects(request(deps, jobs), /VFX_EXECUTION_ALREADY_ACTIVE/);
  assert.equal(calls.length, 1);
});

test("owner only, exact version only, disabled environment writes nothing", async () => {
  const { deps, jobs, ledger, calls } = await setup();
  await assert.rejects(request(deps, jobs, { actorId: other }), /VFX_OWNER_ONLY/);
  await assert.rejects(request(deps, jobs, { revision: 99 }), /VFX_STALE_EXECUTION_REQUEST/);
  await assert.rejects(request({ ...deps, config: { enabled: false, reason: "off" } }, jobs), /VFX_EXECUTION_DISABLED/);
  await assert.rejects(request(deps, jobs, { mode: "reconcile" }), /VFX_NOT_INTERRUPTED/);
  assert.equal(ledger.ops.size, 0); assert.equal(calls.length, 0);
});

test("uncertain dispatch is never retried automatically; refusal frees the job", async () => {
  const { deps, jobs, ledger } = await setup();
  let attempts = 0;
  const uncertain = await request({ ...deps, dispatch: async () => { attempts++; throw new Error("timeout"); } }, jobs);
  assert.equal(uncertain.status, "RECONCILIATION_REQUIRED"); assert.equal(attempts, 1);
  await assert.rejects(request(deps, jobs), /VFX_EXECUTION_ALREADY_ACTIVE/);
  assert.equal(attempts, 1);
  const { deps: d2, jobs: j2, ledger: l2 } = await setup();
  const refused = await request({ ...d2, dispatch: async () => "rejected" }, j2);
  assert.equal(refused.status, "REFUNDED");
  const next = await request(d2, j2);
  assert.equal(next.status, "SUBMITTED"); assert.match(next.key, /:n2$/);
  assert.equal(l2.ops.size, 2); void ledger;
});

test("resolution requires age and GitHub confirmation; it closes without re-dispatching", async () => {
  const { deps, jobs, ledger, calls, advance } = await setup();
  const { key } = await request({ ...deps, dispatch: async () => { throw new Error("network"); } }, jobs);
  const job = await ownedJob(jobs, brief.projectId, owner);
  await assert.rejects(resolveDispatch({ ...deps, runs: async () => [{ id: "7", status: "in_progress", conclusion: null }] }, { id: job.id, actorId: owner, key }), /VFX_DISPATCH_STILL_RUNNING/);
  await assert.rejects(resolveDispatch(deps, { id: job.id, actorId: other, key }), /VFX_OWNER_ONLY/);
  await resolveDispatch({ ...deps, runs: async () => [{ id: "7", status: "completed", conclusion: "cancelled" }] }, { id: job.id, actorId: owner, key });
  assert.equal((await ledger.get(key))?.status, "COMMITTED");
  assert.equal(calls.length, 0, "resolution never dispatches");
  const fresh = await request(deps, jobs);
  assert.equal(fresh.status, "SUBMITTED");
  advance(1000);
  await assert.rejects(resolveDispatch(deps, { id: job.id, actorId: owner, key: fresh.key }), /VFX_DISPATCH_MAY_STILL_RUN/);
  advance(QUEUE_GRACE_MS + 1);
  await resolveDispatch(deps, { id: job.id, actorId: owner, key: fresh.key });
  assert.equal(JSON.parse((await ledger.get(fresh.key))!.resultRef!).outcome.code, "no-run-found");
});

test("runner claims exactly once and refuses another commit, a forged key or an unknown row", async () => {
  const { deps, jobs, ledger, runner, results } = await setup();
  await stage(results, "direction", "direction-out");
  const { key } = await request(deps, jobs);
  await assert.rejects(claimDispatch(ledger, key, { ...runnerId, commit: "d".repeat(40), now: runner.now }), /VFX_DISPATCH_COMMIT_MISMATCH/);
  assert.equal((await ledger.get(key))?.status, "SUBMITTED", "a mismatched runner leaves the row untouched");
  await assert.rejects(claimDispatch(ledger, "vfx_exec:exec-job:r0:n9", { ...runnerId, now: runner.now }), /VFX_DISPATCH_UNKNOWN/);
  await assert.rejects(claimDispatch(ledger, "../../etc", { ...runnerId, now: runner.now }), /VFX_DISPATCH_KEY_INVALID/);
  const [a, b] = await Promise.allSettled([runDispatch(runner, key, runnerId), runDispatch(runner, key, { ...runnerId, runId: "102" })]);
  assert.equal([a, b].filter(r => r.status === "fulfilled").length, 1);
  const row = (await ledger.get(key))!;
  assert.equal(row.status, "COMMITTED"); assert.equal(row.committedUsd, 0);
  assert.equal(JSON.parse(row.resultRef!).outcome.kind, "executed");
  const job = await ownedJob(jobs, brief.projectId, owner);
  assert.equal(job.results.direction.sha256, sha("artifact direction"));
});

test("checks that fail before the task never touch the job (missing, changed or unreviewed material)", async () => {
  const { deps, jobs, ledger, runner, results } = await setup();
  const before = await ownedJob(jobs, brief.projectId, owner);
  let { key } = await request(deps, jobs);
  let outcome = await runDispatch(runner, key, runnerId);
  assert.equal(outcome.kind, "blocked_before_task"); assert.equal(outcome.code, "VFX_ARTIFACT_NOT_STAGED");
  assert.deepEqual(await ownedJob(jobs, brief.projectId, owner), before);
  await stage(results, "direction", "direction-out");
  await results.putBytes(`${brief.projectId}/staged/direction.bin`, Buffer.from("tampered"), "application/octet-stream");
  ({ key } = await request(deps, jobs));
  outcome = await runDispatch(runner, key, runnerId);
  assert.equal(outcome.code, "VFX_STAGED_ARTIFACT_CHANGED");
  assert.deepEqual(await ownedJob(jobs, brief.projectId, owner), before);
  await stage(results, "direction", "direction-out");
  ({ key } = await request(deps, jobs));
  assert.equal((await runDispatch(runner, key, runnerId)).kind, "executed");
  // Styleframe requires a human direction approval first: blocked, job not marked failed.
  await stage(results, "look", "look-out");
  const afterDirection = await ownedJob(jobs, brief.projectId, owner);
  ({ key } = await request(deps, jobs));
  outcome = await runDispatch(runner, key, runnerId);
  assert.equal(outcome.code, "VFX_REVIEW_GATE_PENDING");
  assert.deepEqual(await ownedJob(jobs, brief.projectId, owner), afterDirection);
  const job = afterDirection;
  await approveStage(jobs, job.id, owner, { stage: "direction", planHash: job.planHash, artifactSha256: job.artifacts.direction!, approved: true, checks: CHECKS.direction.map(name => ({ name, pass: true, evidence: "reviewed" })) });
  ({ key } = await request(deps, jobs));
  assert.equal((await runDispatch(runner, key, runnerId)).kind, "executed");
  ({ key } = await request(deps, jobs).catch(e => ({ key: String(e) })));
  assert.match(key, /VFX_NOTHING_TO_EXECUTE/, "a finished plan cannot be dispatched again");
  void ledger;
});

test("a profile that differs from the frozen inventory is refused before the job is touched", async () => {
  const { deps, jobs, runner, results } = await setup();
  await stage(results, "direction", "direction-out");
  const changed: ExecutionProfile = { ...profile, executors: { "artifact-registry": { kind: "stored-artifact", capability: { ...capability, recipeVersion: "artifact-registry/other" }, stages: ["direction", "styleframe"] } } };
  const before = await ownedJob(jobs, brief.projectId, owner);
  const { key } = await request(deps, jobs);
  const outcome = await runDispatch({ ...runner, profile: () => changed }, key, runnerId);
  assert.equal(outcome.code, "VFX_EXECUTOR_OR_PLAN_CHANGED");
  assert.deepEqual(await ownedJob(jobs, brief.projectId, owner), before);
  const { key: k2 } = await request(deps, jobs);
  assert.equal((await runDispatch({ ...runner, profile: () => null }, k2, runnerId)).code, "VFX_EXECUTION_PROFILE_MISSING");
});

test("stale requests and changed jobs are answered without execution", async () => {
  const { deps, jobs, runner, results } = await setup();
  await stage(results, "direction", "direction-out");
  const { key } = await request(deps, jobs);
  // Another worker advances the job between request and run.
  await runTask(jobs, brief.projectId, owner, { "artifact-registry": { capability, allowedStages: ["direction"], async run(t) { return { assetId: t.outputAssetId, sha256: "e".repeat(64), checks: [{ name: "x", pass: true, evidence: "y" }] }; } } });
  const outcome = await runDispatch(runner, key, runnerId);
  assert.equal(outcome.kind, "stale_request");
});

test("interrupted task: no new step while RUNNING; reconcile recovers only measured output", async () => {
  const { deps, jobs, runner, results } = await setup();
  await stage(results, "direction", "direction-out");
  const job = await ownedJob(jobs, brief.projectId, owner);
  assert.ok(await jobs.cas({ ...job, revision: job.revision + 1, status: "RUNNING", activeTask: "direction" }, job.revision));
  await assert.rejects(request(deps, jobs), /VFX_NOTHING_TO_EXECUTE/);
  const view = executionView(await ownedJob(jobs, brief.projectId, owner), [], enabled);
  assert.equal(view.mode, "reconcile"); assert.equal(view.canDispatch, true);
  const { key } = await request(deps, jobs, { mode: "reconcile" });
  const outcome = await runDispatch(runner, key, runnerId);
  assert.equal(outcome.kind, "reconciled");
  const after = await ownedJob(jobs, brief.projectId, owner);
  assert.equal(after.status, "READY"); assert.equal(after.results.direction.sha256, sha("artifact direction"));
});

test("execution view: readable state, active run blocks the button, rejected defect blocks", async () => {
  const { deps, jobs } = await setup();
  const job = await ownedJob(jobs, brief.projectId, owner);
  let view = executionView(job, [], enabled);
  assert.equal(view.canDispatch, true); assert.equal(view.pendingTask, "Dirección");
  assert.equal(executionView(job, [], { enabled: false, reason: "Desactivada" }).reason, "Desactivada");
  await request(deps, jobs);
  view = executionView(job, await (deps.ledger as DispatchLedger).list(job.id), enabled);
  assert.equal(view.canDispatch, false); assert.equal(view.active?.label, "En cola del worker");
  assert.equal(executionView({ ...job, status: "BLOCKED" }, [], enabled).canDispatch, false);
  assert.equal(nextPendingTask(job)?.id, "direction");
  const ops: PaidOperation[] = [];
  assert.equal(executionView({ ...job, results: { direction: { assetId: "d", sha256: "f".repeat(64), checks: [] }, look: { assetId: "l", sha256: "f".repeat(64), checks: [] } } }, ops, enabled).reason, "No quedan tareas por ejecutar; el proyecto espera revisión.");
});

test("server profile for the precampaign job is a zero-cost registry and never comes from input", () => {
  const p = executionProfile("precampaign-three-worlds-v1-preparation");
  assert.ok(p);
  for (const e of Object.values(p.executors)) {
    assert.equal(e.kind, "stored-artifact");
    if (e.kind === "stored-artifact") { assert.equal(e.capability.paid, false); assert.equal(e.capability.recipeVersion, "artifact-registry/approved-styleframes-1"); }
  }
  assert.equal(executionProfile("unknown"), null);
});

test("materials are bound by fingerprint; a changed object is refused", async () => {
  const results = memoryResultStore(); const root = await mkdtemp(join(tmpdir(), "vfx-mat-"));
  await results.putBytes("job/plate.mp4", Buffer.from("plate"), "video/mp4");
  const out = await materialize({ plate: { storagePath: "job/plate.mp4", sha256: sha("plate") }, nested: [{ storagePath: "job/plate.mp4", sha256: sha("plate") }], keep: 3 }, results, root) as { plate: { path: string }; keep: number };
  assert.equal((await readFile(out.plate.path)).toString(), "plate"); assert.equal(out.keep, 3);
  await assert.rejects(materialize({ plate: { storagePath: "job/plate.mp4", sha256: "0".repeat(64) } }, results, root), /VFX_MATERIAL_CHANGED/);
});

test("GitHub transport: 4xx is a refusal, 5xx and network errors are uncertain; run lookup matches the key", async () => {
  const ok = async () => new Response(null, { status: 204 });
  assert.equal(await dispatchExecution(enabled as Extract<ExecutionConfig, { enabled: true }>, "k", ok as typeof fetch), "accepted");
  assert.equal(await dispatchExecution(enabled as Extract<ExecutionConfig, { enabled: true }>, "k", (async () => new Response("no", { status: 422 })) as typeof fetch), "rejected");
  assert.equal(await dispatchExecution(enabled as Extract<ExecutionConfig, { enabled: true }>, "k", (async () => new Response("", { status: 502 })) as typeof fetch), "uncertain");
  assert.equal(await dispatchExecution(enabled as Extract<ExecutionConfig, { enabled: true }>, "k", (async () => { throw new Error("down"); }) as typeof fetch), "uncertain");
  let body = "";
  await dispatchExecution(enabled as Extract<ExecutionConfig, { enabled: true }>, "vfx_exec:j:r1:n1", (async (_u: string, init: RequestInit) => { body = String(init.body); return new Response(null, { status: 204 }); }) as typeof fetch);
  assert.deepEqual(JSON.parse(body), { ref: REF, inputs: { stage: "vfx-director-execute", v2_args: "vfx_exec:j:r1:n1" } });
  const runs = await executionRuns(enabled as Extract<ExecutionConfig, { enabled: true }>, "vfx_exec:j:r1:n1", "2026-10-04T12:00:00Z", (async () => Response.json({ workflow_runs: [
    { id: 1, status: "completed", conclusion: "success", display_title: "vfx-execute vfx_exec:j:r1:n1" }, { id: 2, status: "in_progress", conclusion: null, display_title: "vfx-execute vfx_exec:j:r1:n2" }] })) as typeof fetch);
  assert.deepEqual(runs, [{ id: "1", status: "completed", conclusion: "success" }]);
});

test("page shows readable names and translated states; technical identifiers only in audit details", async () => {
  const { projectName } = await import("./display");
  const { JOB_STATUS_LABELS, taskName } = await import("./execution");
  assert.equal(projectName("precampaign-three-worlds-v1-preparation"), "Precampaña · Tres mundos (Nueva York, playa y luna)");
  assert.equal(projectName("my-new_job"), "My new job");
  const { lightingText } = await import("./display");
  assert.equal(lightingText("night_practical"), "Noche con luces prácticas");
  for (const label of Object.values(JOB_STATUS_LABELS)) assert.doesNotMatch(label, /^[A-Z_]+$/);
  const { jobs } = await setup();
  assert.equal(taskName(await ownedJob(jobs, brief.projectId, owner), "look"), "Fotograma de referencia");
  const page = await readFile(new URL("../../../app/dashboard/vfx/VfxDirectorView.tsx", import.meta.url), "utf8");
  assert.match(page, /overflow-x-hidden/); assert.match(page, /break-all/);
  assert.doesNotMatch(page, />\{id\}</, "project links use readable names");
  assert.doesNotMatch(page, /Estado: \{job\.status\}/, "status is translated");
  assert.match(page, /Detalles de auditoría/);
  const controls = await readFile(new URL("../../../app/dashboard/vfx/ExecutionControls.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(controls, /executors|manifest|script|price/i, "the page cannot send executor configuration");
});
