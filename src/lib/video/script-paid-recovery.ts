import type { GeneratedScript } from "@/lib/providers/types";
import { checkScriptQuality, ScriptQualityError } from "./script-quality";

/** No provider access. Only the authenticated request's committed result may be recovered. */
export async function recoverPaidScript(id: string, ref: string | null | undefined,
  read: (ref: string) => Promise<unknown>, parse: (value: unknown) => GeneratedScript, topic: string): Promise<GeneratedScript> {
  if (!ref?.startsWith(`${id}/paid/`) || !/^op_[a-f0-9]+\.script\.json$/.test(ref.slice(`${id}/paid/`.length)))
    throw new Error("PAID_SCRIPT_INVALID_REFERENCE");
  const response = await read(ref) as { stop_reason?: string; parsed_output?: unknown };
  if (response.stop_reason !== "end_turn" || !response.parsed_output) throw new Error("PAID_SCRIPT_INCOMPLETE");
  const script = parse(response.parsed_output);
  // Length may need editing; every other quality gate remains mandatory.
  const quality = checkScriptQuality(script, { topic, targetWords: 0, providerName: "anthropic" });
  if (!quality.ok) throw new ScriptQualityError(quality);
  return script;
}
