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
}

export function memoryLedgerStore(): LedgerStore & { ops: Map<string, PaidOperation>; writes: number } {
  const ops = new Map<string, PaidOperation>();
  const s = {
    ops, writes: 0,
    async get(k: string) { return ops.get(k) ? { ...ops.get(k)! } : null; },
    async insert(op: PaidOperation) { if (ops.has(op.idempotencyKey)) return false; ops.set(op.idempotencyKey, { ...op }); s.writes++; return true; },
    async update(k: string, expected: PaidOpStatus, patch: Partial<PaidOperation>) { const cur = ops.get(k); if (!cur || cur.status !== expected) return false; ops.set(k, { ...cur, ...patch }); s.writes++; return true; },
  };
  return s;
}

export class ReconciliationRequiredError extends Error {}

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
 * - SUBMITTED without a job id: the provider may have accepted -> RECONCILIATION_REQUIRED.
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
    await store.update(key, "SUBMITTED", { status: "RECONCILIATION_REQUIRED", updatedAt: now() });
    throw new ReconciliationRequiredError(`${key}: a submission without a recorded job id may have been accepted; never resubmitted automatically`);
  }
  let jobId = cur.providerJobId;
  if (cur.status === "RESERVED") {
    if (!(await store.update(key, "RESERVED", { status: "SUBMITTED", updatedAt: now() }))) throw new ReconciliationRequiredError(`${key}: concurrent submission detected`);
    const { providerJobId, submissionReceiptRef } = await port.submit();
    jobId = providerJobId;
    if (!await store.update(key, "SUBMITTED", { status: "PROVIDER_JOB_RECORDED", providerJobId,
      ...(submissionReceiptRef === undefined ? {} : { resultRef: submissionReceiptRef }), updatedAt: now() })) {
      throw new ReconciliationRequiredError(`${key}: accepted job could not be recorded; never resubmit`);
    }
  }
  const r = await port.poll(jobId!);
  if ("refunded" in r) {
    await store.update(key, "PROVIDER_JOB_RECORDED", { status: "REFUNDED", committedUsd: 0, updatedAt: now() });
  } else {
    await store.update(key, "PROVIDER_JOB_RECORDED", { status: "COMMITTED", committedUsd: r.actualUsd, resultRef: r.resultRef, updatedAt: now() });
  }
  return (await store.get(key))!;
}
