/** Safe diagnostics only: never retain a provider's text or thinking in the error. */
export class ScriptOutputError extends Error {
  override name = "ScriptOutputError";
  constructor(readonly reason: "output_limit" | "missing_output") {
    super(`Script output unavailable: ${reason}`);
  }
}

export function requireScriptOutput<T>(response: { stop_reason?: string | null; parsed_output: T | null }): T {
  if (response.stop_reason === "max_tokens") throw new ScriptOutputError("output_limit");
  if (!response.parsed_output) throw new ScriptOutputError("missing_output");
  return response.parsed_output;
}
