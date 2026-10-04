/** Runner half of page-initiated execution (GitHub Actions only). See execution.ts. */
import { compilePlan } from "./index";
import { assertBeforeTask } from "./gates";
import { ownedJob, runTask, reconcileTask, jobGates, type Job, type JobStore } from "./jobs";
import { claimDispatch, finishDispatch, nextPendingTask, type DispatchPayload, type Outcome } from "./execution";
import type { ExecutionProfile, ProfiledExecutor } from "./execution-profiles";
import type { LedgerStore } from "../ledger";

export type RunnerDeps = {
  ledger: LedgerStore; jobs: JobStore; now: () => Date;
  owner: (id: string) => Promise<{ id: string; email_confirmed_at?: string | null } | null>;
  profile: (jobId: string) => ExecutionProfile | null;
  build: (profile: ExecutionProfile, currentJob: () => Promise<Job>) => Promise<Record<string, ProfiledExecutor>>;
};
export type RunnerIdentity = { commit: string; ref: string; runId: string };
const code = (e: unknown) => e instanceof Error && /^[A-Z0-9_:]{3,120}$/.test(e.message) ? e.message
  : e instanceof Error && e.name === "ZodError" ? "VFX_INVALID_CONFIGURATION" : "VFX_RUNNER_ERROR";

/** Claim (exactly once) → checks that never touch the job → one durable task → receipt.
 * Throws only when the dispatch could not be claimed; then the ledger row is left untouched. */
export async function runDispatch(deps: RunnerDeps, key: string, runner: RunnerIdentity): Promise<Outcome> {
  const payload = await claimDispatch(deps.ledger, key, { ...runner, now: deps.now });
  let outcome: Outcome;
  try { outcome = await execute(deps, payload, runner); }
  catch (e) { outcome = { kind: "blocked_before_task", code: code(e), jobStatus: null, jobRevision: null, taskId: payload.taskId, finishedAt: deps.now().toISOString(), runId: runner.runId }; }
  await finishDispatch(deps.ledger, key, payload, outcome);
  return outcome;
}

async function execute(deps: RunnerDeps, p: DispatchPayload, runner: RunnerIdentity): Promise<Outcome> {
  const user = await deps.owner(p.ownerId);
  if (!user || user.id !== p.ownerId || !user.email_confirmed_at) throw new Error("VFX_OWNER_UNVERIFIED");
  const job = await ownedJob(deps.jobs, p.jobId, p.ownerId);
  const result = (kind: Outcome["kind"], j: Pick<Job, "status" | "revision">, c: string | null = null, taskId = p.taskId): Outcome =>
    ({ kind, code: c, jobStatus: j.status, jobRevision: j.revision, taskId, finishedAt: deps.now().toISOString(), runId: runner.runId });
  // The page asked about an exact version; anything else is answered without touching the job.
  if (job.revision !== p.revision || job.planHash !== p.planHash) return result("stale_request", job, "VFX_JOB_CHANGED_SINCE_REQUEST");
  const profile = deps.profile(job.id);
  if (!profile) throw new Error("VFX_EXECUTION_PROFILE_MISSING");
  const executors = await deps.build(profile, () => ownedJob(deps.jobs, p.jobId, p.ownerId));
  const inventory = Object.fromEntries(Object.entries(executors).map(([name, e]) => [name, e.capability]));
  if (p.mode === "reconcile") {
    if (job.status !== "RUNNING" || job.activeTask !== p.taskId) return result("stale_request", job, "VFX_NOT_INTERRUPTED");
    try { const recovered = await reconcileTask(deps.jobs, job.id, p.ownerId, executors); return result("reconciled", recovered); }
    catch (e) { return result("reconciliation_failed", job, code(e)); }
  }
  if (job.status === "RUNNING") return result("stale_request", job, "VFX_JOB_BUSY");
  if (job.status === "BLOCKED") return result("blocked_before_task", job, "VFX_REJECTED_DEFECT_BLOCKS");
  const task = nextPendingTask(job);
  if (!task) return result("nothing_pending", job, null, null);
  if (task.id !== p.taskId) return result("stale_request", job, "VFX_PENDING_TASK_CHANGED");
  // Same checks runTask makes, done first so a misconfigured runner never marks the job FAILED.
  const compiled = compilePlan(job.brief, job.plan, inventory, job.assets);
  if (!compiled.executable || compiled.planHash !== job.planHash) return result("blocked_before_task", job, "VFX_EXECUTOR_OR_PLAN_CHANGED");
  const executor = executors[task.executor];
  if (!executor?.allowedStages.includes(task.stage)) return result("blocked_before_task", job, "VFX_STAGE_UNSUPPORTED");
  try { assertBeforeTask(task.stage, jobGates(job, task.environmentId)); } catch { return result("blocked_before_task", job, "VFX_REVIEW_GATE_PENDING"); }
  if (task.dependsOn.some(d => !job.results[d])) return result("blocked_before_task", job, "VFX_DEPENDENCY_PENDING");
  try { await executor.preflight?.(task); } catch (e) { return result("blocked_before_task", job, code(e)); }
  const run = await runTask(deps.jobs, job.id, p.ownerId, executors, task.id);
  if (run.executed) return result("executed", run.job);
  return result(run.job.status === "FAILED" || run.job.status === "BLOCKED" ? "task_failed" : "stale_request", run.job, run.job.error);
}

/** Read-only diagnostics for operators (no ledger or job writes). */
export async function inspectJob(deps: Pick<RunnerDeps, "jobs" | "profile">, jobId: string, ownerId: string) {
  const job = await ownedJob(deps.jobs, jobId, ownerId);
  const profile = deps.profile(jobId);
  const pending = nextPendingTask(job);
  return { jobId: job.id, revision: job.revision, status: job.status, activeTask: job.activeTask, error: job.error, pendingTask: pending?.id ?? null,
    tasks: job.plan.tasks.length, results: Object.keys(job.results).length, approvals: job.approvals.length,
    inventory: job.inventory, profileExecutors: profile ? Object.fromEntries(Object.entries(profile.executors).map(([n, e]) => [n, e.kind === "stored-artifact" ? e.capability : e.kind])) : null };
}
