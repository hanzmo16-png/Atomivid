import Anthropic from "@anthropic-ai/sdk";
import { classifyPaidCallError, type PaidCallClassification } from "@/lib/paid-calls/gate";

/** HTTP policy of the script provider, by what the SDK proves about the attempt:
 *  - 401 (AuthenticationError) and 403 (PermissionDeniedError): the credential or its permissions were refused
 *    before any generation; nothing was accepted or billed → `rejected_final` (REFUNDED, no retry, configuration
 *    failure shown to the owner). 401: incident 90e3e91d (2026-10-16), which used to end as RECONCILIATION_REQUIRED
 *    and blocked every later script of that request.
 *  - 429 (RateLimitError) and 529 (`overloaded_error`): admission refused, the request was not processed → `rejected`
 *    (REFUNDED; the gate may retry a bounded number of times with a progressive wait, each attempt under its own
 *    ledger key, so no attempt is ever paid twice).
 *  - The explicit compiler rejection (400, below) → `rejected_final`.
 *  - 500/502/503 and any other 5xx, generic 400s, timeouts, connection drops and post-response parsing errors:
 *    the provider may have processed the request → `uncertain` (RECONCILIATION_REQUIRED, operator reconciliation).
 */
export function classifyAnthropicError(error: unknown): PaidCallClassification {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return { kind: "rejected_final" };
  if (error instanceof Anthropic.RateLimitError) return { kind: "rejected" };
  if (error instanceof Anthropic.InternalServerError && isOverloaded(error)) return { kind: "rejected" };
  if (error instanceof Anthropic.BadRequestError) {
    const body = error.error as { error?: { type?: unknown; message?: unknown } } | undefined;
    if (body?.error?.type === "invalid_request_error" && typeof body.error.message === "string"
      && body.error.message.startsWith("The compiled grammar is too large,")) {
      return { kind: "rejected_final" };
    }
  }
  return classifyPaidCallError(error);
}

/** 529 is the SDK's InternalServerError with the provider's `overloaded_error` body: an admission refusal, not a crash. */
function isOverloaded(error: InstanceType<typeof Anthropic.InternalServerError>): boolean {
  const body = error.error as { error?: { type?: unknown } } | undefined;
  return error.status === 529 || body?.error?.type === "overloaded_error";
}

/** Bounded retries of a pre-acceptance refusal (429/529) and their progressive wait, used by the script guard. */
export const SCRIPT_REJECTED_RETRIES = 2;
export const scriptRetryDelayMs = (attempt: number): number => Math.min(2_000 * 2 ** (attempt - 1), 8_000);
