/**
 * Error vocabulary of the paid-call gate (PI V2 Fase B1, RB-01).
 *
 * A provider error is classified into exactly one of:
 * - "rejected": the provider answered and refused BEFORE accepting the work (HTTP 4xx/5xx
 *   on the submit, budget/config refusals). Nothing was charged. The gate may retry ONCE.
 * - "rejected_final": same, but retrying can never change the answer (moderation, config).
 * - "accepted": the provider accepted a job and we know its id; the charge is real or
 *   pending. The row becomes PROVIDER_JOB_RECORDED and is only ever RESUMED, never resent.
 * - "uncertain": a timeout, abort, connection cut or unreadable body after the request left
 *   the process. The provider may have charged. The row becomes RECONCILIATION_REQUIRED and
 *   no attempt ever calls the provider again for that key.
 *
 * Providers mark a pre-acceptance refusal by throwing an error that carries
 * `paidCallOutcome: "rejected"` (duck-typed so existing error classes keep their identity).
 */

export type PaidCallOutcomeTag = "rejected" | "rejected_final";

/** Thrown by a provider adapter when the provider refused the request before accepting it. */
export class ProviderRejectedError extends Error {
  readonly paidCallOutcome: PaidCallOutcomeTag;
  constructor(message: string, outcome: PaidCallOutcomeTag = "rejected") {
    super(message);
    this.name = "ProviderRejectedError";
    this.paidCallOutcome = outcome;
  }
}

export function paidCallOutcomeOf(err: unknown): PaidCallOutcomeTag | null {
  const tag = (err as { paidCallOutcome?: unknown } | null)?.paidCallOutcome;
  return tag === "rejected" || tag === "rejected_final" ? tag : null;
}

/** The ledger says this asset was already paid and committed, but its stored result cannot be loaded. No call is made. */
export class PaidResultUnavailableError extends Error {
  constructor(readonly key: string, readonly resultRef: string | null, reason: string) {
    super(`Paid operation ${key} is COMMITTED but its result (${resultRef ?? "no ref"}) is not available: ${reason}. The provider is not called again.`);
    this.name = "PaidResultUnavailableError";
  }
}

/** The ledger store (pi_paid_operations) could not be read or written. Fail closed: no row, no call. */
export class PaidLedgerUnavailableError extends Error {
  constructor(message: string) {
    super(`pi_paid_operations unavailable: ${message}`);
    this.name = "PaidLedgerUnavailableError";
  }
}
