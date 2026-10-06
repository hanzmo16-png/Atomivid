import Anthropic from "@anthropic-ai/sdk";
import { classifyPaidCallError, type PaidCallClassification } from "@/lib/paid-calls/gate";

/** Only this explicit pre-generation compiler rejection is known here.
 * Generic 400s, timeouts and post-response parsing errors remain uncertain.
 */
export function classifyAnthropicError(error: unknown): PaidCallClassification {
  if (error instanceof Anthropic.BadRequestError) {
    const body = error.error as { error?: { type?: unknown; message?: unknown } } | undefined;
    if (body?.error?.type === "invalid_request_error" && typeof body.error.message === "string"
      && body.error.message.startsWith("The compiled grammar is too large,")) {
      return { kind: "rejected_final" };
    }
  }
  return classifyPaidCallError(error);
}
