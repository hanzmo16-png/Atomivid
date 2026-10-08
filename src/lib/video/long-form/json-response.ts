import { z } from "zod";

/** Complex editorial documents exceed Anthropic's compiled-grammar budget.
 * Keep the complete contract in the prompt and validate locally AFTER the raw
 * response/usage has been durably committed by supplyProtectedAnthropic.
 * This is not a fallback/retry and never weakens the acceptance schema.
 */
export function jsonResponseSystem(system: string, schema: z.ZodType): string {
  return `${system}\nOUTPUT CONTRACT: Return exactly one JSON object matching the following JSON Schema. ` +
    `No markdown fences, commentary or extra keys. All constraints apply.\n${JSON.stringify(z.toJSONSchema(schema, { reused: "ref" }))}`;
}

export class DocumentaryResponseError extends Error {
  /** Structural schema issues ("code@path", e.g. "invalid_value@sections.2.function"); never values or text. For logs only. */
  readonly issues: string[];
  constructor(detail: string, issues: string[] = []) {
    super(`${detail} La respuesta y su consumo quedaron registrados; no se repite la llamada automáticamente.`);
    this.name = "DocumentaryResponseError";
    this.issues = issues;
  }
}

/** Zod issues as "code@path" (indices kept, values never included). */
export function schemaIssuePaths(error: z.ZodError, limit = 12): string[] {
  return error.issues.slice(0, limit).map(i => `${i.code}@${i.path.map(String).join(".")}`);
}

export function parseDocumentaryResponse<T extends z.ZodType>(schema: T, response: {
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
}): z.infer<T> {
  return validateDocumentaryValue(schema, readDocumentaryJson(response));
}

/** The whole JSON document of a completed response (same acceptance rules as before; no salvage). */
export function readDocumentaryJson(response: {
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
}): unknown {
  if (response.stop_reason !== "end_turn") {
    throw new DocumentaryResponseError(response.stop_reason === "max_tokens"
      ? "La respuesta alcanzó el límite de salida del modelo."
      : "El modelo no completó la respuesta.");
  }
  const text = response.content.filter(b => b.type === "text").map(b => b.text ?? "").join("").trim();
  // Accept only a whole JSON document (optionally wrapped in a single code fence).
  // Never salvage a partial object or extract JSON out of explanatory prose.
  const json = text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  try { return JSON.parse(json); }
  catch { throw new DocumentaryResponseError("El modelo devolvió un documento que no se pudo leer."); }
}

export function validateDocumentaryValue<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DocumentaryResponseError("La respuesta no cumple el formato editorial requerido.", schemaIssuePaths(parsed.error));
  }
  return parsed.data;
}
