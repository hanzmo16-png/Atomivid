/**
 * Idempotent paid-operation ledger. Every paid call has one stable idempotency key.
 * Write-ahead SUBMITTED before the provider call means a crash after the provider
 * accepted the job is recoverable: a retry resumes the recorded job or stops for
 * reconciliation; it never submits a second charge automatically.
 * Generalizes the STARTED/COMPLETED records of ai-video-durable-provider.ts.
 */
import { stableHash } from "./canonical";

export type PaidOpStatus = "RESERVED" | "SUBMITTED" | "PROVIDER_JOB_RECORDED" | "COMMITTED" | "REFUNDED" | "RECONCILIATION_REQUIRED";

export type PaidOperation = {
  idempotencyKey: string;
  projectId: string;
  shotId: string;
  provider: string;
  model: string;
  method: string;
  attemptKind: string;
  reservedUsd: number;
  /** Exact provider units when known (e.g. spoken characters), otherwise policy conversion. */
  capacityUnits?: number;
  committedUsd: number | null;
  status: PaidOpStatus;
  providerJobId: string | null;
  resultRef: string | null;
  updatedAt: string;
};

/** Stable fields only: same logical request -> same key; a materially different attempt -> new key. */
export function idempotencyKey(f: { projectId: string; shotId: string; provider: string; model: string; method: string; inputFingerprint: string; attemptOrdinal: number }): string {
  return "op_" + stableHash(f, 32);
}

export interface LedgerStore {
  get(key: string): Promise<PaidOperation | null>;
  /** Insert only if absent; returns false when the key already exists. */
  insert(op: PaidOperation): Promise<boolean>;
  /** Compare-and-set on status; returns false when the current status differs. */
  update(key: string, expected: PaidOpStatus, patch: Partial<PaidOperation>): Promise<boolean>;
  /** Production stores atomically check supply/concurrency AND set SUBMITTED. */
  submit?(op: PaidOperation, at: string): Promise<boolean>;
  /** All operations of these projects (request-level budget: prior spend + pending reservations). */
  listByProjects?(projectIds: string[]): Promise<PaidOperation[]>;
}

export function memoryLedgerStore(): LedgerStore & { ops: Map<string, PaidOperation>; writes: number } {
  const ops = new Map<string, PaidOperation>();
  const s = {
    ops, writes: 0,
    async get(k: string) { return ops.get(k) ? { ...ops.get(k)! } : null; },
    async insert(op: PaidOperation) { if (ops.has(op.idempotencyKey)) return false; ops.set(op.idempotencyKey, { ...op }); s.writes++; return true; },
    async update(k: string, expected: PaidOpStatus, patch: Partial<PaidOperation>) { const cur = ops.get(k); if (!cur || cur.status !== expected) return false; ops.set(k, { ...cur, ...patch }); s.writes++; return true; },
    async listByProjects(ids: string[]) { return [...ops.values()].filter((o) => ids.includes(o.projectId)).map((o) => ({ ...o })); },
  };
  return s;
}

export class ReconciliationRequiredError extends Error {}

/**
 * D-RACE (T-20261019-1602): another caller owns a live submission of this key (row SUBMITTED, or the
 * RESERVED→SUBMITTED compare-and-set was won by someone else). The row is NOT touched: the winner keeps the
 * right to record its provider job and commit. Subclass of ReconciliationRequiredError so every existing
 * caller keeps blocking (no second provider send); `inFlight` lets the UI say "en curso" instead of
 * "reconciliar".
 */
export class SubmissionInFlightError extends ReconciliationRequiredError {
  override name = "SubmissionInFlightError";
  readonly inFlight = true;
}

/** Evidence obtained FROM THE PROVIDER (job lookup, billing record). Elapsed time is never evidence. */
export type ProviderEvidence =
  | { kind: "accepted"; providerJobId: string }
  | { kind: "committed"; providerJobId: string; resultRef: string; actualUsd: number }
  | { kind: "not_charged"; proof: string };

export type ProviderPort = {
  /** Submit a job; must return the provider job id as soon as it is accepted. */
  submit(): Promise<{ providerJobId: string; submissionReceiptRef?: string }>;
  /** Wait for a previously accepted job (resume path never calls submit). */
  poll(providerJobId: string): Promise<{ resultRef: string; actualUsd: number } | { refunded: true }>;
};

/**
 * Execute one paid operation idempotently.
 * - COMMITTED: return the stored result (no charge).
 * - PROVIDER_JOB_RECORDED: resume polling the same job (no resubmit).
 * - SUBMITTED without a job id: owned by a live (or orphaned) submission -> SubmissionInFlightError, row untouched.
 * - absent or RESERVED: write SUBMITTED first, then submit.
 */
export async function executePaidOperation(store: LedgerStore, op: Omit<PaidOperation, "status" | "providerJobId" | "resultRef" | "committedUsd" | "updatedAt">, port: ProviderPort, now: () => string): Promise<PaidOperation> {
  const key = op.idempotencyKey;
  let cur = await store.get(key);
  if (!cur) {
    const fresh: PaidOperation = { ...op, status: "RESERVED", providerJobId: null, resultRef: null, committedUsd: null, updatedAt: now() };
    if (!(await store.insert(fresh))) cur = await store.get(key); else cur = fresh;
  }
  if (!cur) throw new Error("Ledger read failed " + key);
  if (cur.status === "COMMITTED" || cur.status === "REFUNDED") return cur;
  if (cur.status === "RECONCILIATION_REQUIRED") throw new ReconciliationRequiredError(`${key}: reconcile with the provider before any new submission`);
  if (cur.status === "SUBMITTED") {
    // D-RACE: never mutate a live submission owned by someone else. Whether it is a legitimately in-flight
    // call or an orphan (crashed owner / lost response) cannot be decided from this side; either way no second
    // send happens. An orphan is flagged only by flagStaleSubmission (explicit, auditable) or resolved with
    // provider evidence (reconcileWithProviderEvidence).
    throw new SubmissionInFlightError(`${key}: a submission is in flight (or its outcome is unknown); not resubmitted and not modified`);
  }
  let jobId = cur.providerJobId;
  /** Status the settlement compare-and-set expects (PROVIDER_JOB_RECORDED, or RECONCILIATION_REQUIRED when the
   * row was flagged stale while this owner's call was in flight; the DB trigger forbids moving back to PJR). */
  let settleFrom: PaidOpStatus = "PROVIDER_JOB_RECORDED";
  if (cur.status === "RESERVED") {
    const submitted = store.submit ? await store.submit(cur, now()) : await store.update(key, "RESERVED", { status: "SUBMITTED", updatedAt: now() });
    if (!submitted) throw new SubmissionInFlightError(`${key}: concurrent submission detected; the winner owns the call`);
    const { providerJobId, submissionReceiptRef } = await port.submit();
    jobId = providerJobId;
    const recorded = { status: "PROVIDER_JOB_RECORDED" as const, providerJobId,
      ...(submissionReceiptRef === undefined ? {} : { resultRef: submissionReceiptRef }), updatedAt: now() };
    if (!await store.update(key, "SUBMITTED", recorded)) {
      // The row was flagged RECONCILIATION_REQUIRED while this call was in flight (time-based flag). The job id
      // we hold is provider evidence that beats a time-based suspicion: annotate it (status unchanged, the
      // forward-only trigger forbids going back) and settle from RECONCILIATION_REQUIRED so the paid result is kept.
      if (!await store.update(key, "RECONCILIATION_REQUIRED", { providerJobId, updatedAt: now() })) {
        throw new ReconciliationRequiredError(`${key}: accepted job ${providerJobId} could not be recorded; never resubmit`);
      }
      settleFrom = "RECONCILIATION_REQUIRED";
    }
  }
  const r = await port.poll(jobId!);
  if ("refunded" in r) {
    await store.update(key, settleFrom, { status: "REFUNDED", committedUsd: 0, updatedAt: now() });
  } else {
    if (!await store.update(key, settleFrom, { status: "COMMITTED", committedUsd: r.actualUsd, resultRef: r.resultRef, providerJobId: jobId, updatedAt: now() })) {
      const after = await store.get(key);
      // Idempotent: someone (a resumer) committed the same job first; never a duplicate settlement.
      if (after?.status === "COMMITTED" && after.providerJobId === jobId) return after;
      throw new ReconciliationRequiredError(`${key}: settlement of job ${jobId} lost (row is ${after?.status ?? "missing"}); not overwritten`);
    }
  }
  return (await store.get(key))!;
}

/**
 * Explicit, auditable flag for a SUBMITTED row nobody resolved (crashed owner, lost response): moves it to
 * RECONCILIATION_REQUIRED. It NEVER returns the row to RESERVED and never authorizes a new provider send:
 * elapsed time is not proof that the provider did not charge. A live owner that later obtains the job id can
 * still record it (see executePaidOperation). Returns false when the row is not SUBMITTED or is younger than
 * `minAgeMs` (legitimately in flight is never reconciled artificially).
 */
export async function flagStaleSubmission(store: LedgerStore, key: string, opts: { minAgeMs: number; now: () => string }): Promise<boolean> {
  const cur = await store.get(key);
  if (!cur || cur.status !== "SUBMITTED") return false;
  const age = Date.parse(opts.now()) - Date.parse(cur.updatedAt);
  if (!(Number.isFinite(age) && age >= opts.minAgeMs)) return false;
  return store.update(key, "SUBMITTED", { status: "RECONCILIATION_REQUIRED", updatedAt: opts.now() });
}

/**
 * Resolve an uncertain row ONLY with provider evidence. accepted → job id recorded, still blocked (no resubmit);
 * committed → COMMITTED with the provider's amount; not_charged (with a non-empty proof reference) → REFUNDED 0.
 * No transition re-opens the key for a new send: a new send needs a new, explicitly authorized operation.
 */
export async function reconcileWithProviderEvidence(store: LedgerStore, key: string, ev: ProviderEvidence, now: () => string): Promise<PaidOperation> {
  const cur = await store.get(key);
  if (!cur) throw new Error(`Ledger row missing ${key}`);
  if (cur.status !== "RECONCILIATION_REQUIRED" && cur.status !== "SUBMITTED") throw new ReconciliationRequiredError(`${key}: status ${cur.status} is not reconcilable`);
  let patch: Partial<PaidOperation>;
  // accepted: annotate the job id and keep the row blocked (the forward-only trigger forbids RR→PJR); the result
  // is settled later with "committed" evidence. From SUBMITTED it may still move forward to PJR.
  if (ev.kind === "accepted") patch = cur.status === "SUBMITTED"
    ? { status: "PROVIDER_JOB_RECORDED", providerJobId: ev.providerJobId, updatedAt: now() }
    : { providerJobId: ev.providerJobId, updatedAt: now() };
  else if (ev.kind === "committed") {
    if (!(Number.isFinite(ev.actualUsd) && ev.actualUsd >= 0)) throw new ReconciliationRequiredError(`${key}: invalid provider amount`);
    patch = { status: "COMMITTED", providerJobId: ev.providerJobId, resultRef: ev.resultRef, committedUsd: ev.actualUsd, updatedAt: now() };
  } else {
    if (!ev.proof.trim()) throw new ReconciliationRequiredError(`${key}: not_charged needs a provider proof reference`);
    patch = { status: "REFUNDED", committedUsd: 0, resultRef: `reconciled:not_charged:${ev.proof.slice(0, 200)}`, updatedAt: now() };
  }
  if (!await store.update(key, cur.status, patch)) throw new ReconciliationRequiredError(`${key}: row changed during reconciliation; re-read`);
  return (await store.get(key))!;
}
