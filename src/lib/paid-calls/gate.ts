/**
 * Paid-call gate for the Generate path (PI V2 Fase B1, RB-01 + RB-03 re-pay).
 *
 * Reuses the frozen PI V1 engine (`executePaidOperation`, `idempotencyKey`) and the
 * `pi_paid_operations` table (migration 0023). This module only adds the policy the engine
 * leaves to its caller:
 *
 * 1. The ledger row is written (RESERVED -> SUBMITTED) before any HTTP request. If the row
 *    cannot be written, the provider is not called.
 * 2. The idempotency key is local: project (request id) + shot + provider + model + method +
 *    input fingerprint + attempt ordinal. It never includes render_attempts, so a later
 *    attempt of the same request lands on the same row.
 * 3. COMMITTED -> the stored result is loaded, never regenerated. SUBMITTED /
 *    PROVIDER_JOB_RECORDED / RECONCILIATION_REQUIRED -> the engine refuses to call.
 * 4. A failure after the request left the process ("uncertain") moves the row to
 *    RECONCILIATION_REQUIRED. A failure that carries a provider job id ("accepted") moves it
 *    to PROVIDER_JOB_RECORDED. Neither ever triggers another submit.
 * 5. A refusal before acceptance ("rejected") moves the row to REFUNDED (committed_usd 0,
 *    result_ref "rejected:..."). Whether the provider bills such an answer (upstream_error,
 *    rate_limited, HTTP refusal) is not known, so by default there is no automatic retry
 *    (PI V2 COST-A2); a caller may still opt in on the ordinal-1 key, except for upstream_error
 *    and rate_limited, which are never retried (COST-A2b). "rejected_final" never retries.
 */
import { ledgerUsd } from "./ledger-usd";
import { stableHash } from "@/lib/production-intelligence/canonical";
import {
  executePaidOperation,
  idempotencyKey,
  ReconciliationRequiredError,
  type LedgerStore,
  type PaidOperation,
  type PaidOpStatus,
  type ProviderPort,
} from "@/lib/production-intelligence/ledger";
import { GenerativeProviderError } from "@/lib/providers/types";
import { PaidResultUnavailableError, paidCallOutcomeOf } from "./errors";

export type { LedgerStore, PaidOperation } from "@/lib/production-intelligence/ledger";
export { ReconciliationRequiredError } from "@/lib/production-intelligence/ledger";

export type PaidCallSpec = {
  /** video_requests.id (or the operator production id). */
  projectId: string;
  /** Stable asset identity inside the project, e.g. "voice:ab12…", "image:scene-3", "ai_video:S07". */
  shotId: string;
  provider: string;
  model: string;
  method: string;
  /** Everything that makes this request THIS request (text, prompt, settings…). Hashed canonically. */
  inputFingerprint: unknown;
  reservedUsd: number;
  capacityUnits?: number;
  attemptKind?: string;
};

export type PaidCallResult<T> = { result: T; costUsd: number; resultRef: string; providerJobId?: string };

export type PaidCallClassification = { kind: "rejected" | "rejected_final" | "uncertain" } | { kind: "accepted"; providerJobId: string };

export type PaidCallHooks<T> = {
  /** The paid request. Must return the stored reference of the result. */
  call: (ctx: { key: string; attemptOrdinal: number }) => Promise<PaidCallResult<T>>;
  /** Load a previously committed result from its reference; null when it is not there. */
  load: (resultRef: string, ctx: { key: string }) => Promise<T | null>;
  /** Resume a PROVIDER_JOB_RECORDED job without resubmitting (optional; absent = reconcile). */
  resume?: (providerJobId: string, ctx: { key: string }) => Promise<PaidCallResult<T>>;
  classify?: (err: unknown) => PaidCallClassification;
  /** Retries after a pre-acceptance refusal. Default 0 (economically uncertain). Never applies to accepted/uncertain failures. */
  maxRejectedRetries?: number;
  /** Wait before retry number `attempt` (1-based) of a pre-acceptance refusal; absent or 0 = immediate. */
  retryDelayMs?: (attempt: number) => number;
  /**
   * Runs after the wait and BEFORE the retry calls the provider, with the retry's row already reserved. Throwing
   * aborts the chain: the reserved retry row is released (REFUNDED, RELEASED_RETRY_REF) and the error propagates.
   * Callers use it to re-check request-level state (another operation uncertain or active) with fresh data.
   */
  beforeRetry?: (ctx: { key: string; attemptOrdinal: number }) => Promise<void>;
  now?: () => string;
};

/** resultRef of a retry reservation released because its chain was aborted before calling the provider. */
export const RELEASED_RETRY_REF = "released:retry-aborted-before-call";
/** resultRef of a retry reservation released because the rejected attempt before it could not be settled (its CAS was lost). */
export const RELEASED_SETTLEMENT_LOST_REF = "released:previous-attempt-settlement-lost";

export type PaidCallBlockState = "in_flight" | "requires_reconciliation";
type ReadStatus = PaidOpStatus | "missing" | "unreadable";

/**
 * CORRECCIÓN-2 (T32): the compare-and-set that settles a rejected attempt (SUBMITTED → REFUNDED) was lost, either because
 * the row changed concurrently (`false`) or because the write failed. The chain stops without calling the provider again;
 * the retry reservation it owned is released with RELEASED_SETTLEMENT_LOST_REF; both rows are re-read and left as they
 * are. `block` is conservative: "in_flight" while any of the two rows is still live, else "requires_reconciliation".
 */
export class PaidCallSettlementLostError extends ReconciliationRequiredError {
  override name = "PaidCallSettlementLostError";
  constructor(
    readonly block: PaidCallBlockState,
    readonly key: string,
    readonly nextKey: string,
    readonly rows: { previous: ReadStatus; retry: ReadStatus; retryReleased: boolean | "write_failed" | "not_owned" },
    readonly cause?: unknown,
  ) {
    super(`${key}: the settlement of the rejected attempt was not recorded (${cause instanceof Error ? `write failed: ${cause.message}` : "row changed concurrently"}); rows re-read: previous=${rows.previous}, retry=${rows.retry} (released=${String(rows.retryReleased)}); blocked as ${block}, no further provider call`);
  }
}

const LIVE_STATUSES: ReadonlySet<string> = new Set<PaidOpStatus>(["RESERVED", "SUBMITTED", "PROVIDER_JOB_RECORDED"]);

async function settlementLost(store: LedgerStore, key: string, nextKey: string, ownsRetry: boolean, now: () => string, cause: unknown): Promise<PaidCallSettlementLostError> {
  let retryReleased: boolean | "write_failed" | "not_owned" = "not_owned";
  if (ownsRetry) {
    try {
      retryReleased = await store.update(nextKey, "RESERVED", { status: "REFUNDED", committedUsd: 0, resultRef: RELEASED_SETTLEMENT_LOST_REF, updatedAt: now() });
    } catch {
      retryReleased = "write_failed";
    }
  }
  // Re-read, never rewrite: whatever state the rows really have is preserved and reported.
  const read = async (k: string): Promise<ReadStatus> => { try { return (await store.get(k))?.status ?? "missing"; } catch { return "unreadable"; } };
  const previous = await read(key);
  const retry = await read(nextKey);
  const block: PaidCallBlockState = LIVE_STATUSES.has(previous) || LIVE_STATUSES.has(retry) ? "in_flight" : "requires_reconciliation";
  return new PaidCallSettlementLostError(block, key, nextKey, { previous, retry, retryReleased }, cause);
}

export type GuardedPaidCall<T> = { result: T; reused: boolean; costUsd: number; key: string; attemptOrdinal: number };

const REJECTED_FINAL_REASONS = new Set<GenerativeProviderError["reason"]>([
  "moderation_rejected",
  "budget_exceeded",
  "not_configured",
  "invalid_request",
  "contract_unverified",
  "authentication_error",
  "quota_exceeded",
]);
const REJECTED_REASONS = new Set<GenerativeProviderError["reason"]>(["upstream_error", "rate_limited"]);
/** upstream_error / rate_limited: whether the provider billed is unknown, so no caller may retry them (COST-A2b). */
const isBillingUncertainRefusal = (err: unknown) => err instanceof GenerativeProviderError && REJECTED_REASONS.has(err.reason);

/** Default classification. Anything unknown is "uncertain": the only safe assumption about money. */
export function classifyPaidCallError(err: unknown): PaidCallClassification {
  const tag = paidCallOutcomeOf(err);
  if (tag) return { kind: tag };
  if (err instanceof GenerativeProviderError) {
    if (err.providerJobId) return { kind: "accepted", providerJobId: err.providerJobId };
    if (REJECTED_FINAL_REASONS.has(err.reason)) return { kind: "rejected_final" };
    if (REJECTED_REASONS.has(err.reason)) return { kind: "uncertain" };
  }
  return { kind: "uncertain" };
}

export function paidCallKey(spec: PaidCallSpec, attemptOrdinal = 0): string {
  return idempotencyKey({
    projectId: spec.projectId,
    shotId: spec.shotId,
    provider: spec.provider,
    model: spec.model,
    method: spec.method,
    inputFingerprint: stableHash(spec.inputFingerprint, 32),
    attemptOrdinal,
  });
}

const REJECTED_REF = "rejected:";
const isRetryableRejection = (op: PaidOperation) => op.status === "REFUNDED" && (op.resultRef ?? "").startsWith(`${REJECTED_REF}rejected:`);

export async function guardPaidCall<T>(store: LedgerStore, rawSpec: PaidCallSpec, hooks: PaidCallHooks<T>): Promise<GuardedPaidCall<T>> {
  // Precisión monetaria: validar y normalizar ANTES de cualquier escritura en el ledger o llamada al proveedor.
  const spec: PaidCallSpec = { ...rawSpec, reservedUsd: ledgerUsd(rawSpec.reservedUsd, "reserved_usd") };
  const now = hooks.now ?? (() => new Date().toISOString());
  const maxRejectedRetries = hooks.maxRejectedRetries ?? 0;
  const classify = hooks.classify ?? classifyPaidCallError;
  let lastRejection: unknown = null;

  for (let ordinal = 0; ordinal <= maxRejectedRetries; ordinal++) {
    const key = paidCallKey(spec, ordinal);
    let captured: PaidCallResult<T> | undefined;
    let calledNow = false;

    const port: ProviderPort = {
      async submit() {
        calledNow = true;
        captured = await hooks.call({ key, attemptOrdinal: ordinal });
        captured = { ...captured, costUsd: ledgerUsd(captured.costUsd, "committed_usd") };
        return { providerJobId: captured.providerJobId ?? `sync:${key}` };
      },
      async poll(providerJobId) {
        if (captured) return { resultRef: captured.resultRef, actualUsd: captured.costUsd };
        if (hooks.resume && !providerJobId.startsWith("sync:")) {
          captured = await hooks.resume(providerJobId, { key });
          captured = { ...captured, costUsd: ledgerUsd(captured.costUsd, "committed_usd") };
          return { resultRef: captured.resultRef, actualUsd: captured.costUsd };
        }
        throw new ReconciliationRequiredError(`${key}: provider job ${providerJobId} is recorded and cannot be resumed from this call site; reconcile before any new submission`);
      },
    };

    let op: PaidOperation;
    try {
      op = await executePaidOperation(
        store,
        {
          idempotencyKey: key,
          projectId: spec.projectId,
          shotId: spec.shotId,
          provider: spec.provider,
          model: spec.model,
          method: spec.method,
          attemptKind: ordinal === 0 ? (spec.attemptKind ?? "initial") : "rejected_retry",
          reservedUsd: spec.reservedUsd,
          capacityUnits: spec.capacityUnits,
        },
        port,
        now,
      );
    } catch (err) {
      if (err instanceof ReconciliationRequiredError || !calledNow) throw err;
      const c = classify(err);
      if (c.kind === "accepted") {
        await store.update(key, "SUBMITTED", { status: "PROVIDER_JOB_RECORDED", providerJobId: c.providerJobId, updatedAt: now() });
        throw err;
      }
      if (c.kind === "rejected" || c.kind === "rejected_final") {
        const message = err instanceof Error ? err.message : String(err);
        const refund = { status: "REFUNDED" as const, committedUsd: 0, resultRef: `${REJECTED_REF}${c.kind}:${message.slice(0, 200)}`, updatedAt: now() };
        if (!(c.kind === "rejected" && ordinal < maxRejectedRetries && !isBillingUncertainRefusal(err))) {
          await store.update(key, "SUBMITTED", refund);
          throw err;
        }
        // Exclusion across the wait: the NEXT attempt's row is reserved BEFORE this one is refunded, so at no instant
        // is the request without a live (RESERVED/SUBMITTED) row; a concurrent intent of the same request is held
        // off by the intent selector for the whole chain, not only while a call is in flight. The insert is unique:
        // if the next key already exists, someone else owns that attempt and this chain stops without calling again.
        const nextKey = paidCallKey(spec, ordinal + 1);
        const reservedNext = await store.insert({
          idempotencyKey: nextKey, projectId: spec.projectId, shotId: spec.shotId, provider: spec.provider, model: spec.model, method: spec.method,
          attemptKind: "rejected_retry", reservedUsd: spec.reservedUsd, capacityUnits: spec.capacityUnits,
          status: "RESERVED", providerJobId: null, resultRef: null, committedUsd: null, updatedAt: now(),
        });
        // CORRECCIÓN-2: the settlement is a compare-and-set. Losing it (false, or a write error) means the rejected row
        // changed under this chain or the ledger is unreliable: no further provider call, release of the retry row
        // this chain owns (with its own cause), re-read of both rows and a typed conservative block. Nothing is rewritten.
        let settled: boolean;
        try {
          settled = await store.update(key, "SUBMITTED", refund);
        } catch (writeErr) {
          throw await settlementLost(store, key, nextKey, reservedNext, now, writeErr);
        }
        if (!settled) throw await settlementLost(store, key, nextKey, reservedNext, now, undefined);
        if (!reservedNext) throw err;
        lastRejection = err;
        const delay = hooks.retryDelayMs?.(ordinal + 1) ?? 0;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        if (hooks.beforeRetry) {
          try {
            await hooks.beforeRetry({ key: nextKey, attemptOrdinal: ordinal + 1 });
          } catch (guardErr) {
            await store.update(nextKey, "RESERVED", { status: "REFUNDED", committedUsd: 0, resultRef: RELEASED_RETRY_REF, updatedAt: now() });
            throw guardErr;
          }
        }
        continue;
      }
      await store.update(key, "SUBMITTED", { status: "RECONCILIATION_REQUIRED", updatedAt: now() });
      throw err;
    }

    if (op.status === "COMMITTED") {
      if (captured) return { result: captured.result, reused: false, costUsd: captured.costUsd, key, attemptOrdinal: ordinal };
      const loaded = op.resultRef ? await hooks.load(op.resultRef, { key }) : null;
      if (loaded === null || loaded === undefined) throw new PaidResultUnavailableError(key, op.resultRef, "stored result missing or invalid");
      return { result: loaded, reused: true, costUsd: 0, key, attemptOrdinal: ordinal };
    }
    if (op.status === "REFUNDED") {
      if (isRetryableRejection(op) && ordinal < maxRejectedRetries) continue;
      if ((op.resultRef ?? "").startsWith(REJECTED_REF)) {
        throw lastRejection ?? new PaidResultUnavailableError(key, op.resultRef, "the provider already refused this request; no further retry is allowed");
      }
      throw new PaidResultUnavailableError(key, op.resultRef, "operation was refunded");
    }
    throw new ReconciliationRequiredError(`${key}: unexpected ledger status ${op.status}`);
  }
  throw lastRejection ?? new Error("paid call gate: retry budget exhausted");
}

/** After a PROVIDER_JOB_RECORDED job was resumed elsewhere and its result stored, close the row. No-op when the row is in another state. */
export async function commitRecordedPaidJob(store: LedgerStore, key: string, outcome: { costUsd: number; resultRef: string }, now: () => string = () => new Date().toISOString()): Promise<boolean> {
  return store.update(key, "PROVIDER_JOB_RECORDED", { status: "COMMITTED", committedUsd: ledgerUsd(outcome.costUsd, "committed_usd"), resultRef: outcome.resultRef, updatedAt: now() });
}
