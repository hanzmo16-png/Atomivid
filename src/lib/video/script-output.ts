import type { z } from "zod";

export type ScriptOutputReason = "output_limit" | "missing_output" | "invalid_json" | "invalid_schema" | "refusal" | "deadline_exceeded";
/** Safe diagnostics only: never retain a provider's text or thinking in the error. */
export class ScriptOutputError extends Error {
  override name = "ScriptOutputError";
  constructor(readonly reason: ScriptOutputReason) {
    super(`Script output unavailable: ${reason}`);
  }
}

/** Decode only AFTER the raw response and usage have been saved by the paid-call gate.
 * messages.parse() throws before returning max_tokens/refusal/invalid JSON responses.
 * Keeping decoding outside that gate distinguishes a known paid response from network uncertainty.
 */
export function parseStoredScriptOutput<T>(response: {
  stop_reason?: string | null;
  content: Array<{ type: string; text?: string }>;
}, schema: z.ZodType<T>): T {
  if (response.stop_reason === "max_tokens" || response.stop_reason === "model_context_window_exceeded") throw new ScriptOutputError("output_limit");
  if (response.stop_reason === "refusal") throw new ScriptOutputError("refusal");
  if (response.stop_reason !== "end_turn") throw new ScriptOutputError("missing_output");
  const text = response.content.filter(b => b.type === "text").map(b => b.text ?? "").join("\n");
  if (!text.trim()) throw new ScriptOutputError("missing_output");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ScriptOutputError("invalid_json"); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ScriptOutputError("invalid_schema");
  return parsed.data;
}

/** Shared budget for all length corrections, leaving room within the 60s route for persistence.
 * Expiry before a correction must not reserve or submit another paid operation.
 */
export function scriptCallBudget(now: () => number = Date.now, budgetMs = 40_000) {
  const deadline = now() + budgetMs;
  return {
    beforeCall() {
      if (deadline - now() < 5_000) throw new ScriptOutputError("deadline_exceeded");
    },
    options() { return { maxRetries: 0, timeout: Math.max(1, deadline - now()) }; },
  };
}

export function requireScriptOutput<T>(response: { stop_reason?: string | null; parsed_output: T | null }): T {
  if (response.stop_reason === "max_tokens") throw new ScriptOutputError("output_limit");
  if (!response.parsed_output) throw new ScriptOutputError("missing_output");
  return response.parsed_output;
}
