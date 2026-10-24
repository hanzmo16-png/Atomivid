/**
 * Persistent per-job spend authorization (Travis Walton Ep. 2, 2026-10-23; incident PR #194 / job e8048599).
 *
 * Rule: a paid call of an authorization-required project (podcast episodes and documentary scripts) may reach
 * the provider ONLY if a stored authorization exists for that project, belongs to the project's owner, is ACTIVE,
 * and committed + pending + this reservation <= cap. The check and the RESERVED→SUBMITTED transition are one
 * atomic step (the production version is supabase/proposals/20261024000000_spend_authorizations.sql, which locks
 * the authorization row FOR UPDATE inside pi_submit_with_supply). Missing authorization = refusal (fail closed),
 * never "no cap".
 *
 * This module is the executable model of that rule (same arithmetic, same per-project serialization) used by the
 * free tests, plus the preflight a resume/retry must pass BEFORE requeueing anything.
 */
import type { LedgerStore, PaidOperation } from "@/lib/production-intelligence/ledger";

export const AUTHORIZATION_REQUIRED_PREFIXES = ["podcast-", "documentary:"] as const;
export const requiresAuthorization = (projectId: string) => AUTHORIZATION_REQUIRED_PREFIXES.some((p) => projectId.startsWith(p));

export type SpendAuthorization = {
  projectId: string; ownerId: string; capUsd: number; authorizationRef: string; status: "ACTIVE" | "CLOSED";
  /** Operations that existed when the authorization was granted (already paid before it; never counted against it). */
  baselineKeys?: readonly string[];
};

export class SpendAuthorizationError extends Error {
  constructor(readonly reason: "authorization missing" | "authorization closed" | "authorization owner mismatch" | "authorization exceeded" | "authorization cost unverified" | "uncertain operations", readonly detail: Record<string, unknown> = {}) {
    super(`SPEND_AUTHORIZATION: ${reason}`);
    this.name = "SpendAuthorizationError";
  }
}

const OPEN = new Set(["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"]);
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Spend counted against an authorization: COMMITTED (actual cost) + open reservations, baseline excluded. */
export function authorizationUsage(auth: SpendAuthorization, ops: readonly PaidOperation[], excludeKey?: string) {
  const base = new Set(auth.baselineKeys ?? []);
  let committedUsd = 0, pendingUsd = 0;
  for (const o of ops) {
    if (o.projectId !== auth.projectId || o.idempotencyKey === excludeKey || base.has(o.idempotencyKey)) continue;
    if (o.status === "COMMITTED") committedUsd += Number(o.committedUsd ?? o.reservedUsd) || 0;
    else if (OPEN.has(o.status)) pendingUsd += Number(o.reservedUsd) || 0;
  }
  return { capUsd: auth.capUsd, committedUsd: r4(committedUsd), pendingUsd: r4(pendingUsd), remainingUsd: r4(auth.capUsd - committedUsd - pendingUsd) };
}

export type AuthorizationReader = { get(projectId: string): Promise<SpendAuthorization | null> };

/**
 * Wraps a ledger so that its atomic submit enforces the stored authorization before the provider is called.
 * A per-project lock serializes the check-and-submit (the SQL proposal uses SELECT … FOR UPDATE on the
 * authorization row), so two racing resumes can never both pass the same remaining amount.
 */
export function authorizedLedger<L extends LedgerStore>(ledger: L, auths: AuthorizationReader, ownerOf: (projectId: string) => string | null): L {
  const locks = new Map<string, Promise<unknown>>();
  const inner = ledger.submit?.bind(ledger);
  const submit = async (op: PaidOperation, at: string): Promise<boolean> => {
    if (!requiresAuthorization(op.projectId)) return inner ? inner(op, at) : ledger.update(op.idempotencyKey, "RESERVED", { status: "SUBMITTED", updatedAt: at });
    const prev = locks.get(op.projectId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((res) => { release = res; });
    locks.set(op.projectId, prev.then(() => mine));
    await prev;
    try {
      const auth = await auths.get(op.projectId);
      if (!auth) throw new SpendAuthorizationError("authorization missing", { projectId: op.projectId });
      if (auth.status !== "ACTIVE") throw new SpendAuthorizationError("authorization closed", { capUsd: auth.capUsd });
      if (auth.ownerId !== ownerOf(op.projectId)) throw new SpendAuthorizationError("authorization owner mismatch");
      if (!(Number.isFinite(op.reservedUsd) && op.reservedUsd > 0)) throw new SpendAuthorizationError("authorization cost unverified");
      const cur = await ledger.get(op.idempotencyKey);
      if (!cur || cur.status !== "RESERVED") return false;
      const ops = ledger.listByProjects ? await ledger.listByProjects([op.projectId]) : [];
      const u = authorizationUsage(auth, ops, op.idempotencyKey);
      if (u.committedUsd + u.pendingUsd + op.reservedUsd > auth.capUsd + 1e-9) throw new SpendAuthorizationError("authorization exceeded", { ...u, requestedUsd: op.reservedUsd });
      return inner ? inner(op, at) : ledger.update(op.idempotencyKey, "RESERVED", { status: "SUBMITTED", updatedAt: at });
    } finally { release(); }
  };
  return Object.assign(Object.create(Object.getPrototypeOf(ledger)), ledger, { submit }) as L;
}

/**
 * Preflight of any resume or retry, BEFORE the job is requeued: a stored, ACTIVE authorization of the job's owner
 * with money left and nothing uncertain. A typed confirmation alone is not an authorization (incident PR #194).
 */
export function resumeAuthorizationRefusal(auth: SpendAuthorization | null, ownerId: string, usage: { pendingUsd: number; remainingUsd: number } | null): string | null {
  if (!auth) return "no stored spend authorization for this job (open one with pi_open_recovery_budget first)";
  if (auth.ownerId !== ownerId) return "stored authorization belongs to another owner";
  if (auth.status !== "ACTIVE") return "stored authorization is closed (reopen it with pi_resume_recovery_budget and a new authorization_ref)";
  if (!usage) return "authorization usage could not be read";
  if (usage.pendingUsd > 0) return "uncertain operations must be reconciled first";
  if (usage.remainingUsd <= 0) return "stored authorization is exhausted";
  return null;
}
