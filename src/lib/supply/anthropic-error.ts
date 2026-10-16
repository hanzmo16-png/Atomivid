import Anthropic from "@anthropic-ai/sdk";
import { classifyPaidCallError, type PaidCallClassification } from "@/lib/paid-calls/gate";

/** Only these explicit pre-generation rejections are known here:
 *  - HTTP 401 (Anthropic.AuthenticationError): the credential was refused before any generation, so nothing was
 *    accepted or billed (incident 90e3e91d, 2026-10-16: it used to end as RECONCILIATION_REQUIRED and blocked
 *    every later script of that request). The error itself still reaches the route: script-error.ts names it a
 *    configuration failure that a retry will not fix.
 *  - The explicit compiler rejection below (400).
 * Generic 400s, 403, 429, 5xx, timeouts, connection drops and post-response parsing errors remain uncertain.
 */
export function classifyAnthropicError(error: unknown): PaidCallClassification {
  if (error instanceof Anthropic.AuthenticationError) return { kind: "rejected_final" };
  if (error instanceof Anthropic.BadRequestError) {
    const body = error.error as { error?: { type?: unknown; message?: unknown } } | undefined;
    if (body?.error?.type === "invalid_request_error" && typeof body.error.message === "string"
      && body.error.message.startsWith("The compiled grammar is too large,")) {
      return { kind: "rejected_final" };
    }
  }
  return classifyPaidCallError(error);
}
