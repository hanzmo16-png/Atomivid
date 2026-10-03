import { BriefSchema, PlanSchema, compilePlan, type Brief, type Plan, type Executor, type Inventory, type Check, type Environment } from "./index";
import { stableHash } from "../canonical";
import { GATE_VERSION, assertBeforeTask, assertGate, CHECKS, STAGES, type Approval, type GateContext, type Stage } from "./gates";

export type TaskResult = { assetId: string; sha256: string; checks: Check[] };
export type Job = { id: string; ownerId: string; revision: number; brief: Brief; plan: Plan; inventory: Inventory; assets: string[];
  planHash: string; approvals: Approval[]; artifacts: GateContext["artifacts"]; results: Record<string, TaskResult>;
  environmentArtifacts?: Record<string, GateContext["artifacts"]>;
  status: "READY" | "RUNNING" | "BLOCKED" | "FAILED" | "REVIEW_REQUIRED"; activeTask: string | null; error: string | null };
/** Reviews bind to this world's contract and its transitive dependencies, not the job ID.
 * Unrelated worlds can retain their measured outputs after a local correction. */
export function environmentHash(job: Pick<Job, "brief" | "plan" | "inventory" | "assets">, environmentId: string): string {
  const environment = job.plan.environments.find(e => e.id === environmentId);
  if (!environment) throw new Error("VFX_ENVIRONMENT_UNKNOWN");
  const selected = new Set(job.plan.tasks.filter(t => t.environmentId === environmentId).map(t => t.id));
  for (const task of [...job.plan.tasks].reverse()) if (selected.has(task.id)) task.dependsOn.forEach(id => selected.add(id));
  const tasks = job.plan.tasks.filter(t => selected.has(t.id));
  const brief = { ...job.brief, environments: undefined };
  const shared = { ...job.plan, environments: undefined, tasks: undefined };
  const dependencies = job.plan.environments.filter(e => tasks.some(t => t.environmentId === e.id));
  const inventory = Object.fromEntries([...new Set(tasks.map(t => t.executor))].map(name => [name, job.inventory[name]]));
  const assets = job.assets.filter(id => tasks.some(t => t.inputAssetIds.includes(id)));
  return stableHash({ brief, shared, environment, dependencies, tasks, inventory, assets, gateVersion: GATE_VERSION }, 64);
}
export function jobGates(job: Job, environmentId?: string): GateContext {
  if (environmentId) return { planHash: environmentHash(job, environmentId), artifacts: job.environmentArtifacts?.[environmentId] ?? {},
    approvals: job.approvals.filter(a => a.environmentId === environmentId) };
  return { planHash: job.planHash, artifacts: job.artifacts, approvals: job.approvals.filter(a => !a.environmentId),
    ...(job.plan.environments.length ? { environments: Object.fromEntries(job.plan.environments.map(e => [e.id, jobGates(job, e.id)])) } : {}) };
}
function operationKey(job: Job, task: Plan["tasks"][number]) {
  return `${task.environmentId ? environmentHash(job, task.environmentId) : job.planHash}:${task.id}`;
}
function recordArtifact(job: Job, task: Plan["tasks"][number], sha256: string) {
  const artifacts = { ...job.artifacts };
  const environmentArtifacts = structuredClone(job.environmentArtifacts ?? {});
  if (task.stage !== "preview") {
    if (task.environmentId) environmentArtifacts[task.environmentId] = { ...environmentArtifacts[task.environmentId], [task.stage]: sha256 };
    else artifacts[task.stage] = sha256;
  }
  return { artifacts, environmentArtifacts };
}
export interface JobStore {
  get(id: string): Promise<Job | null>;
  insert(job: Job): Promise<boolean>;
  cas(job: Job, expectedRevision: number): Promise<boolean>;
}
export function requireOwner(actorId: string, ownerId: string) {
  if (!actorId || actorId !== ownerId) throw new Error("VFX_OWNER_ONLY");
}
export async function createJob(store: JobStore, actorId: string, ownerId: string, brief: unknown, plan: unknown, inventory: Inventory, assets: string[]) {
  requireOwner(actorId, ownerId);
  const c = compilePlan(brief, plan, inventory, assets);
  if (!c.executable) throw new Error(c.errors.join("; "));
  const job: Job = { id: c.brief.projectId, ownerId, revision: 0, brief: c.brief, plan: c.plan, inventory, assets,
    planHash: c.planHash, approvals: [], artifacts: {}, environmentArtifacts: {}, results: {}, status: "READY", activeTask: null, error: null };
  if (await store.insert(job)) return job;
  const existing = await ownedJob(store, job.id, actorId);
  if (existing.planHash !== job.planHash) throw new Error("JOB_VERSION_CONFLICT: replace plan explicitly");
  return existing;
}
export async function ownedJob(store: JobStore, id: string, actorId: string) {
  const job = await store.get(id);
  if (!job) throw new Error("VFX_JOB_NOT_FOUND");
  requireOwner(actorId, job.ownerId); return { ...job, brief: BriefSchema.parse(job.brief), plan: PlanSchema.parse(job.plan) };
}
async function save(store: JobStore, job: Job) {
  const next = { ...job, revision: job.revision + 1 };
  if (!await store.cas(next, job.revision)) throw new Error("VFX_CONCURRENT_UPDATE");
  return next;
}
export async function replacePlan(store: JobStore, id: string, actorId: string, plan: unknown) {
  const job = await ownedJob(store, id, actorId);
  if (job.status === "RUNNING") throw new Error("VFX_JOB_BUSY");
  const c = compilePlan(job.brief, plan, job.inventory, job.assets);
  if (!c.executable) throw new Error(c.errors.join("; "));
  if (c.planHash === job.planHash) return job;
  const next = { ...job, plan: c.plan, planHash: c.planHash };
  const retained = new Set(c.plan.environments.filter(e => job.plan.environments.some(old => old.id === e.id) && environmentHash(job, e.id) === environmentHash(next, e.id)).map(e => e.id));
  const results: Job["results"] = {};
  for (const task of c.plan.tasks) {
    if (task.environmentId && retained.has(task.environmentId) && job.results[task.id] && task.dependsOn.every(id => results[id])) results[task.id] = job.results[task.id];
  }
  return save(store, { ...next, approvals: job.approvals.filter(a => a.environmentId && retained.has(a.environmentId)), artifacts: {},
    environmentArtifacts: Object.fromEntries([...retained].map(id => [id, job.environmentArtifacts?.[id] ?? {}])), results, status: "READY", activeTask: null, error: null });
}
/** Hashes must come from measured worker output; the API cannot register arbitrary artifacts. */
export async function approveStage(store: JobStore, id: string, actorId: string, input: { environmentId?: string; stage: Stage; planHash: string; artifactSha256: string; approved: boolean; checks: Check[] }) {
  let job = await ownedJob(store, id, actorId);
  if (job.status === "RUNNING") throw new Error("VFX_JOB_BUSY");
  if (input.stage === "master" && input.environmentId || job.plan.environments.length && input.stage !== "master" && !input.environmentId) throw new Error("VFX_REVIEW_SCOPE_REQUIRED");
  const prior = jobGates(job, input.environmentId);
  if (!STAGES.includes(input.stage) || input.planHash !== prior.planHash || input.artifactSha256 !== prior.artifacts[input.stage]) throw new Error("VFX_STALE_APPROVAL");
  const approval: Approval = { ...input, reviewerId: actorId };
  const context = { ...prior, approvals: [...prior.approvals, approval] };
  if (input.approved) { assertBeforeTask(input.stage, context); assertGate(input.stage, context); }
  job = { ...job, approvals: [...job.approvals, approval], status: input.approved ? "READY" : "BLOCKED", error: input.approved ? null : `rejected ${input.stage}` };
  return save(store, job);
}
export type DurableExecutor = Omit<Executor, "run"> & { run: (task: Plan["tasks"][number], brief: Brief, operationKey: string, environment?: Environment) => Promise<TaskResult>;
  recover?: (task: Plan["tasks"][number], brief: Brief, operationKey: string, environment?: Environment) => Promise<TaskResult | null> };
/** One task per invocation. CAS persists ownership BEFORE invoking the executor.
 * A process death leaves RUNNING and requires reconciliation; it never reruns blindly. */
export async function runTask(store: JobStore, id: string, actorId: string, executors: Record<string, DurableExecutor>, taskId?: string) {
  let job = await ownedJob(store, id, actorId);
  if (job.status === "RUNNING") return { job, executed: false };
  if (taskId && !job.plan.tasks.some(t => t.id === taskId)) throw new Error("VFX_TASK_UNKNOWN");
  if (taskId && job.results[taskId]) return { job, executed: false };
  const task = job.plan.tasks.find(t => !job.results[t.id] && (!taskId || t.id === taskId));
  if (!task) return { job: job.status === "REVIEW_REQUIRED" ? job : await save(store, { ...job, status: "REVIEW_REQUIRED" }), executed: false };
  try {
    const inventory = Object.fromEntries(Object.entries(executors).map(([name, e]) => [name, e.capability]));
    const compiled = compilePlan(job.brief, job.plan, inventory, job.assets);
    if (!compiled.executable || compiled.planHash !== job.planHash) throw new Error("VFX_EXECUTOR_OR_PLAN_CHANGED");
    const executor = executors[task.executor];
    if (!executor.allowedStages.includes(task.stage)) throw new Error("VFX_STAGE_UNSUPPORTED");
    const context = jobGates(job, task.environmentId);
    assertBeforeTask(task.stage, context);
    if (task.dependsOn.some(dependency => !job.results[dependency])) throw new Error("VFX_DEPENDENCY_PENDING");
    job = await save(store, { ...job, status: "RUNNING", activeTask: task.id, error: null });
    // Stable even on resumption. Executors must use this for non-destructive output paths.
    const result = await executor.run(task, job.brief, operationKey(job, task), job.plan.environments.find(e => e.id === task.environmentId));
    if (result.assetId !== task.outputAssetId || !/^[a-f0-9]{64}$/.test(result.sha256)) throw new Error("VFX_OUTPUT_INVALID");
    if (!result.checks.length || result.checks.some(c => !c.pass || !c.evidence.trim())) throw new Error("VFX_EXECUTOR_QA_FAILED");
    const measured = recordArtifact(job, task, result.sha256);
    return { job: await save(store, { ...job, results: { ...job.results, [task.id]: result }, ...measured, status: "READY", activeTask: null }), executed: true };
  } catch (error) {
    if (error instanceof Error && error.message === "VFX_CONCURRENT_UPDATE") return { job: await ownedJob(store, id, actorId), executed: false };
    const message = error instanceof Error ? error.message : "VFX_TASK_FAILED";
    return { job: await save(store, { ...job, status: job.status === "RUNNING" ? "FAILED" : "BLOCKED", activeTask: null, error: message }), executed: false };
  }
}
/** Test store only; production uses Supabase CAS. */
export function memoryJobStore(): JobStore {
  const rows = new Map<string, Job>();
  return { async get(id) { return rows.has(id) ? structuredClone(rows.get(id)!) : null; },
    async insert(job) { if (rows.has(job.id)) return false; rows.set(job.id, structuredClone(job)); return true; },
    async cas(job, revision) { if (rows.get(job.id)?.revision !== revision) return false; rows.set(job.id, structuredClone(job)); return true; } };
}
/** Recover existing output only. A missing result stays blocked; never regenerate an
 * interrupted task automatically. Call only once the prior runner has terminated. */
export async function reconcileTask(store: JobStore, id: string, actorId: string, executors: Record<string, DurableExecutor>) {
  const job = await ownedJob(store, id, actorId);
  if (job.status !== "RUNNING" || !job.activeTask) throw new Error("VFX_NOT_INTERRUPTED");
  const task = job.plan.tasks.find(t => t.id === job.activeTask)!;
  const executor = executors[task.executor];
  if (!executor?.recover) throw new Error("VFX_RECONCILIATION_REQUIRED");
  const inventory = Object.fromEntries(Object.entries(executors).map(([name, e]) => [name, e.capability]));
  const compiled = compilePlan(job.brief, job.plan, inventory, job.assets);
  if (!compiled.executable || compiled.planHash !== job.planHash) throw new Error("VFX_EXECUTOR_OR_PLAN_CHANGED");
  assertBeforeTask(task.stage, jobGates(job, task.environmentId));
  const result = await executor.recover(task, job.brief, operationKey(job, task), job.plan.environments.find(e => e.id === task.environmentId));
  if (!result || result.assetId !== task.outputAssetId || !/^[a-f0-9]{64}$/.test(result.sha256) || !result.checks.length || result.checks.some(c => !c.pass || !c.evidence.trim())) throw new Error("VFX_RECOVERY_OUTPUT_INVALID");
  const measured = recordArtifact(job, task, result.sha256);
  return save(store, { ...job, results: { ...job.results, [task.id]: result }, ...measured, activeTask: null, status: "READY", error: null });
}
export { CHECKS };
