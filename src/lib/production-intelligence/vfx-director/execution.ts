/**
 * Page-initiated durable execution of the VFX Director, controlled by server configuration.
 *
 * The browser may only ask "execute the next task of job X at revision R / plan hash H" (or reconcile
 * an interrupted task, or resolve a dispatch it can see). Executors, file paths, prices and manifests
 * never come from the request: the runner loads them from code (execution-profiles.ts) at the exact
 * deployed commit, which the dispatch record pins.
 *
 * Ledger-first: a dispatch row is inserted in `pi_paid_operations` BEFORE any network call
 * (reserved/committed USD 0). Forward-only statuses (enforced by the table trigger) map to:
 *   RESERVED                → registered, dispatch not yet confirmed
 *   SUBMITTED               → GitHub accepted the workflow dispatch; the runner may claim it once
 *   PROVIDER_JOB_RECORDED   → claimed by exactly one runner (providerJobId = GitHub run id)
 *   RECONCILIATION_REQUIRED → dispatch outcome unknown (timeout / 5xx); never retried automatically
 *   COMMITTED               → finished with a recorded outcome (including "nothing to do" and
 *                             owner-resolved interruptions)
 *   REFUNDED                → GitHub definitively refused the dispatch; nothing ran
 * Any non-final row blocks a new dispatch for the same job. An uncertain or interrupted dispatch is
 * resolved only by an explicit owner action after the server confirms with GitHub that no run of
 * that dispatch is still queued or running.
 */
import { z } from "zod";
import type { LedgerStore, PaidOperation } from "../ledger";
import { ownedJob, type Job, type JobStore } from "./jobs";
import { STAGE_LABELS } from "./review-view";

export const DISPATCH_METHOD = "vfx_execution_dispatch";
/** Registered on the default branch; the dispatched ref supplies the job definition. */
export const EXECUTION_WORKFLOW = "precampaign-teaser-v1.yml";
export const EXECUTION_STAGE_INPUT = "vfx-director-execute";
/** Workflow timeout (30 min) plus queueing margin: an older claimed row is treated as interrupted. */
export const RUNNER_STALE_MS = 45 * 60_000;
/** A dispatch accepted by GitHub may wait in the queue; before this it is never "lost". */
export const QUEUE_GRACE_MS = 10 * 60_000;

const ACTIVE = ["RESERVED", "SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"] as const;
type ActiveStatus = typeof ACTIVE[number];
const isActive = (op: PaidOperation): op is PaidOperation & { status: ActiveStatus } => (ACTIVE as readonly string[]).includes(op.status);

export const ExecutionModeSchema = z.enum(["step", "reconcile"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
/** The complete browser vocabulary: identifiers of an exact version only. Strict: executors, paths,
 * prices, manifests or any other field are rejected, not ignored. */
export const ExecuteRequestSchema = z.object({ action: z.literal("execute"), id: z.string().min(1).max(200), mode: ExecutionModeSchema,
  revision: z.number().int().nonnegative(), planHash: z.string().min(1).max(200) }).strict();
export const ResolveDispatchRequestSchema = z.object({ action: z.literal("resolve-dispatch"), id: z.string().min(1).max(200), key: z.string().min(1).max(300) }).strict();
const sha40 = z.string().regex(/^[a-f0-9]{40}$/);
export const DispatchPayloadSchema = z.object({
  version: z.literal(1), jobId: z.string().min(1), ownerId: z.string().min(1), mode: ExecutionModeSchema,
  revision: z.number().int().nonnegative(), planHash: z.string().min(1), taskId: z.string().min(1).nullable(),
  commit: sha40, ref: z.string().min(1), workflow: z.literal(EXECUTION_WORKFLOW), requestedAt: z.string().datetime(),
}).strict();
export type DispatchPayload = z.infer<typeof DispatchPayloadSchema>;
export const OutcomeSchema = z.object({
  kind: z.enum(["executed", "task_failed", "nothing_pending", "blocked_before_task", "stale_request", "reconciled", "reconciliation_failed", "resolved_without_receipt"]),
  code: z.string().max(200).nullable(), jobStatus: z.string().nullable(), jobRevision: z.number().int().nullable(),
  taskId: z.string().nullable(), finishedAt: z.string().datetime(), runId: z.string().nullable(),
}).strict();
export type Outcome = z.infer<typeof OutcomeSchema>;
/** Dispatch ledger: the paid-operations store plus a project-scoped listing. */
export interface DispatchLedger extends LedgerStore { list(jobId: string): Promise<PaidOperation[]> }

// ---------------------------------------------------------------------------------------------
// Server configuration (environment gates). Never derived from the request.
export type ExecutionConfig = { enabled: true; token: string; repo: string; ref: string; commit: string } | { enabled: false; reason: string };
export function executionConfig(env: Record<string, string | undefined> = process.env): ExecutionConfig {
  const vercelEnv = env.VERCEL_ENV;
  const enabled = env.VFX_EXECUTION_ENABLED ?? (vercelEnv === "preview" ? "1" : "0");
  if (enabled !== "1") return { enabled: false, reason: "La ejecución desde la página está desactivada en este entorno." };
  if (vercelEnv === "production" && env.VFX_EXECUTION_PRODUCTION !== "1") return { enabled: false, reason: "La ejecución desde la página no está habilitada en producción." };
  const token = env.GH_WORKER_TOKEN, repo = env.GH_WORKER_REPO;
  const ref = env.VFX_EXECUTION_REF ?? env.VERCEL_GIT_COMMIT_REF, commit = env.VERCEL_GIT_COMMIT_SHA;
  if (!token || !repo) return { enabled: false, reason: "Falta la credencial del worker de GitHub en este entorno." };
  if (!/^[^\s/]+\/[^\s/]+$/.test(repo)) return { enabled: false, reason: "La configuración del repositorio del worker no es válida." };
  if (!ref || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(ref) || ref.includes("..")) return { enabled: false, reason: "No se conoce la rama desplegada de esta versión." };
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) return { enabled: false, reason: "No se conoce el commit desplegado de esta versión." };
  return { enabled: true, token, repo, ref, commit };
}

// ---------------------------------------------------------------------------------------------
// Job state helpers (mirror runTask's task selection exactly).
export function nextPendingTask(job: Pick<Job, "plan" | "results">) {
  return job.plan.tasks.find(t => !job.results[t.id]) ?? null;
}
const WORLD_NAMES: Record<string, string> = { nyc: "Nueva York", beach: "Playa", moon: "Luna" };
export function environmentName(id: string) { return WORLD_NAMES[id] ?? id; }
export function taskName(job: Pick<Job, "plan">, taskId: string | null): string | null {
  if (!taskId) return null;
  const task = job.plan.tasks.find(t => t.id === taskId);
  if (!task) return "Tarea desconocida";
  const stage = task.stage === "preview" ? "Prueba previa" : STAGE_LABELS[task.stage];
  return task.environmentId ? `${environmentName(task.environmentId)} · ${stage}` : stage;
}
export const JOB_STATUS_LABELS: Record<Job["status"], string> = {
  READY: "Lista", RUNNING: "En ejecución", BLOCKED: "Bloqueada", FAILED: "Falló — requiere revisión", REVIEW_REQUIRED: "Pendiente de revisión",
};
const DISPATCH_LABELS: Record<string, string> = {
  RESERVED: "Registrada, enviando al worker", SUBMITTED: "En cola del worker", PROVIDER_JOB_RECORDED: "En ejecución en el worker",
  RECONCILIATION_REQUIRED: "Resultado incierto — requiere conciliación", COMMITTED: "Terminada", REFUNDED: "No se envió",
};
const OUTCOME_LABELS: Record<Outcome["kind"], string> = {
  executed: "Tarea ejecutada y medida", task_failed: "La tarea falló; quedó registrada para revisión", nothing_pending: "No había tareas pendientes",
  blocked_before_task: "Bloqueada antes de tocar el proyecto", stale_request: "Solicitud desactualizada; no se tocó el proyecto",
  reconciled: "Tarea interrumpida recuperada", reconciliation_failed: "No se pudo recuperar la tarea interrumpida",
  resolved_without_receipt: "Cerrada por el propietario tras confirmar que no seguía activa",
};
export type DispatchView = { key: string; status: string; label: string; outcome: string | null; code: string | null; mode: ExecutionMode | null;
  task: string | null; requestedAt: string | null; updatedAt: string; runId: string | null; resolvable: boolean };
function payloadOf(op: PaidOperation): (Partial<DispatchPayload> & { outcome?: Outcome }) | null {
  try { const v = JSON.parse(op.resultRef ?? "null"); return v && typeof v === "object" ? v : null; } catch { return null; }
}
export function dispatchView(job: Pick<Job, "plan">, op: PaidOperation, now: number): DispatchView {
  const p = payloadOf(op), outcome = p?.outcome ? OutcomeSchema.safeParse(p.outcome) : null;
  const age = now - Date.parse(op.updatedAt);
  const resolvable = op.status === "RECONCILIATION_REQUIRED" || op.status === "RESERVED" && age > QUEUE_GRACE_MS
    || op.status === "SUBMITTED" && age > QUEUE_GRACE_MS || op.status === "PROVIDER_JOB_RECORDED" && age > RUNNER_STALE_MS;
  return { key: op.idempotencyKey, status: op.status, label: DISPATCH_LABELS[op.status] ?? op.status,
    outcome: outcome?.success ? OUTCOME_LABELS[outcome.data.kind] : null, code: outcome?.success ? outcome.data.code : null,
    mode: p?.mode === "step" || p?.mode === "reconcile" ? p.mode : null, task: taskName(job, typeof p?.taskId === "string" ? p.taskId : null),
    requestedAt: typeof p?.requestedAt === "string" ? p.requestedAt : null, updatedAt: op.updatedAt, runId: op.providerJobId, resolvable };
}
export type ExecutionView = { config: { enabled: boolean; reason: string | null }; mode: ExecutionMode | null; canDispatch: boolean; reason: string | null;
  pendingTask: string | null; dispatches: DispatchView[]; active: DispatchView | null };
/** What the page may offer. The API re-checks every condition server-side. */
export function executionView(job: Job, ops: PaidOperation[], config: ExecutionConfig, now = Date.now()): ExecutionView {
  const sorted = [...ops].filter(o => o.method === DISPATCH_METHOD && o.projectId === job.id).sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey, "en", { numeric: true }));
  const dispatches = sorted.map(o => dispatchView(job, o, now)).reverse();
  const active = dispatches.find(d => (ACTIVE as readonly string[]).includes(d.status)) ?? null;
  const pending = nextPendingTask(job);
  const mode: ExecutionMode | null = job.status === "RUNNING" ? "reconcile" : pending ? "step" : null;
  let reason: string | null = null;
  if (!config.enabled) reason = config.reason;
  else if (active) reason = "Hay una ejecución registrada que todavía no terminó.";
  else if (!mode) reason = "No quedan tareas por ejecutar; el proyecto espera revisión.";
  else if (job.status === "BLOCKED") reason = "Un defecto rechazado bloquea el avance. Corrige ese entorno antes de ejecutar.";
  return { config: { enabled: config.enabled, reason: config.enabled ? null : config.reason }, mode, canDispatch: reason === null, reason,
    pendingTask: taskName(job, job.status === "RUNNING" ? job.activeTask : pending?.id ?? null), dispatches: dispatches.slice(0, 10), active };
}

/** Safe, readable API errors (no internals). */
export const EXECUTION_ERROR_MESSAGES: Record<string, string> = {
  VFX_EXECUTION_DISABLED: "La ejecución desde la página no está habilitada en este entorno.",
  VFX_STALE_EXECUTION_REQUEST: "El proyecto cambió desde que se cargó la página. Actualiza y vuelve a intentarlo.",
  VFX_EXECUTION_ALREADY_ACTIVE: "Ya hay una ejecución registrada para este proyecto; espera su resultado.",
  VFX_NOTHING_TO_EXECUTE: "No hay una tarea ejecutable: no quedan pendientes o un defecto bloquea el avance.",
  VFX_NOT_INTERRUPTED: "No hay una tarea interrumpida que conciliar.",
  VFX_DISPATCH_NOT_RESOLVABLE: "Esa ejecución no existe o ya terminó.",
  VFX_DISPATCH_MAY_STILL_RUN: "Esa ejecución todavía puede estar en cola o en curso. Espera antes de cerrarla.",
  VFX_DISPATCH_STILL_RUNNING: "GitHub indica que esa ejecución sigue en curso.",
  VFX_RUN_LOOKUP_FAILED: "No se pudo confirmar con GitHub el estado de la ejecución. No se cerró nada.",
  VFX_DISPATCH_RECORD_CONFLICT: "Otra acción actualizó la ejecución al mismo tiempo. Actualiza la página.",
  VFX_JOB_NOT_FOUND: "No se encontró el proyecto.",
};

// ---------------------------------------------------------------------------------------------
// Request (server API). Owner identity is already verified by the caller (directorActor).
export type DispatchResult = "accepted" | "rejected" | "uncertain";
export type ExecutionDeps = { jobs: JobStore; ledger: DispatchLedger; config: ExecutionConfig; now: () => Date;
  dispatch: (config: Extract<ExecutionConfig, { enabled: true }>, key: string) => Promise<DispatchResult>;
  runs: (config: Extract<ExecutionConfig, { enabled: true }>, key: string, since: string) => Promise<{ id: string; status: string; conclusion: string | null }[]> };
export async function requestExecution(deps: ExecutionDeps, input: { id: string; actorId: string; mode: ExecutionMode; revision: number; planHash: string }) {
  const { config } = deps;
  if (!config.enabled) throw new Error("VFX_EXECUTION_DISABLED");
  const job = await ownedJob(deps.jobs, input.id, input.actorId);
  if (job.revision !== input.revision || job.planHash !== input.planHash) throw new Error("VFX_STALE_EXECUTION_REQUEST");
  const ops = (await deps.ledger.list(job.id)).filter(o => o.method === DISPATCH_METHOD);
  if (ops.some(isActive)) throw new Error("VFX_EXECUTION_ALREADY_ACTIVE");
  const pending = nextPendingTask(job);
  if (input.mode === "step" && (job.status === "RUNNING" || job.status === "BLOCKED" || !pending)) throw new Error("VFX_NOTHING_TO_EXECUTE");
  if (input.mode === "reconcile" && (job.status !== "RUNNING" || !job.activeTask)) throw new Error("VFX_NOT_INTERRUPTED");
  const now = deps.now().toISOString();
  const payload: DispatchPayload = { version: 1, jobId: job.id, ownerId: job.ownerId, mode: input.mode, revision: job.revision, planHash: job.planHash,
    taskId: input.mode === "reconcile" ? job.activeTask : pending!.id, commit: config.commit, ref: config.ref, workflow: EXECUTION_WORKFLOW, requestedAt: now };
  // Sequence = rows already recorded for this job: two concurrent requests compute the same key and
  // only one insert succeeds (unique idempotency key), even across server instances.
  const key = `vfx_exec:${job.id}:r${job.revision}:n${ops.length + 1}`;
  const inserted = await deps.ledger.insert({ idempotencyKey: key, projectId: job.id, shotId: payload.taskId ?? "job", provider: "internal",
    model: `vfx-execution/${config.commit.slice(0, 12)}`, method: DISPATCH_METHOD, attemptKind: input.mode, reservedUsd: 0, committedUsd: null,
    status: "RESERVED", providerJobId: null, resultRef: JSON.stringify(payload), updatedAt: now });
  if (!inserted) throw new Error("VFX_EXECUTION_ALREADY_ACTIVE");
  let result: DispatchResult;
  try { result = await deps.dispatch(config, key); } catch { result = "uncertain"; }
  const status = result === "accepted" ? "SUBMITTED" : result === "rejected" ? "REFUNDED" : "RECONCILIATION_REQUIRED";
  // Never retried here: an uncertain dispatch may have queued a run.
  if (!await deps.ledger.update(key, "RESERVED", { status, ...(status === "REFUNDED" ? { committedUsd: 0 } : {}), updatedAt: deps.now().toISOString() })) throw new Error("VFX_DISPATCH_RECORD_CONFLICT");
  return { key, status, result };
}

/** Owner closes an uncertain/interrupted dispatch after the server confirms with GitHub that no run of
 * it is queued or running. Never re-dispatches; a new execution needs a new explicit request. */
export async function resolveDispatch(deps: ExecutionDeps, input: { id: string; actorId: string; key: string }) {
  if (!deps.config.enabled) throw new Error("VFX_EXECUTION_DISABLED");
  const job = await ownedJob(deps.jobs, input.id, input.actorId);
  const op = await deps.ledger.get(input.key);
  if (!op || op.method !== DISPATCH_METHOD || op.projectId !== job.id || !isActive(op)) throw new Error("VFX_DISPATCH_NOT_RESOLVABLE");
  const view = dispatchView(job, op, deps.now().getTime());
  if (!view.resolvable) throw new Error("VFX_DISPATCH_MAY_STILL_RUN");
  const payload = payloadOf(op) ?? {};
  const runs = await deps.runs(deps.config, op.idempotencyKey, typeof payload.requestedAt === "string" ? payload.requestedAt : op.updatedAt);
  if (runs.some(r => r.status !== "completed")) throw new Error("VFX_DISPATCH_STILL_RUNNING");
  const outcome: Outcome = { kind: "resolved_without_receipt", code: runs.length ? `runs:${runs.map(r => `${r.id}=${r.conclusion ?? "unknown"}`).join(",")}`.slice(0, 200) : "no-run-found",
    jobStatus: job.status, jobRevision: job.revision, taskId: typeof payload.taskId === "string" ? payload.taskId : null, finishedAt: deps.now().toISOString(), runId: op.providerJobId };
  if (!await deps.ledger.update(op.idempotencyKey, op.status, { status: "COMMITTED", committedUsd: 0, resultRef: JSON.stringify({ ...payload, outcome, resolvedBy: input.actorId }), updatedAt: outcome.finishedAt })) throw new Error("VFX_DISPATCH_RECORD_CONFLICT");
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// Runner side.
/** Exactly one runner can move SUBMITTED → PROVIDER_JOB_RECORDED. A re-run of the same workflow,
 * a forged dispatch or a different commit is refused before touching the job. */
export async function claimDispatch(ledger: LedgerStore, key: string, runner: { commit: string; ref: string; runId: string; now: () => Date }) {
  if (!/^vfx_exec:[A-Za-z0-9._-]+:r\d+:n\d+$/.test(key)) throw new Error("VFX_DISPATCH_KEY_INVALID");
  const op = await ledger.get(key);
  if (!op || op.method !== DISPATCH_METHOD || op.provider !== "internal") throw new Error("VFX_DISPATCH_UNKNOWN");
  if (op.status !== "SUBMITTED") throw new Error("VFX_DISPATCH_NOT_CLAIMABLE");
  const payload = DispatchPayloadSchema.parse(JSON.parse(op.resultRef ?? "null"));
  if (op.projectId !== payload.jobId || key.split(":")[1] !== payload.jobId) throw new Error("VFX_DISPATCH_JOB_MISMATCH");
  if (payload.commit !== runner.commit || payload.ref !== runner.ref) throw new Error("VFX_DISPATCH_COMMIT_MISMATCH");
  if (!await ledger.update(key, "SUBMITTED", { status: "PROVIDER_JOB_RECORDED", providerJobId: runner.runId, updatedAt: runner.now().toISOString() })) throw new Error("VFX_DISPATCH_NOT_CLAIMABLE");
  return payload;
}
export async function finishDispatch(ledger: LedgerStore, key: string, payload: DispatchPayload, outcome: Outcome) {
  const parsed = OutcomeSchema.parse(outcome);
  if (!await ledger.update(key, "PROVIDER_JOB_RECORDED", { status: "COMMITTED", committedUsd: 0, resultRef: JSON.stringify({ ...payload, outcome: parsed }), updatedAt: parsed.finishedAt })) throw new Error("VFX_DISPATCH_RECORD_CONFLICT");
}
