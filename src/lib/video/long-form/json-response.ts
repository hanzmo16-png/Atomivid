import { z } from "zod";
import { acceptContract, extractJsonDocument } from "./response-normalizer";

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

/** JSON type of a value ("null" and "array" kept apart from "object"); never the value itself. */
export function jsonType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

/** Bounds of a visual-plan diagnostic: the schema allows at most 12 scenes. */
export const SHAPE_LIMITS = { scenes: 12 } as const;

/**
 * Per-scene shape of a visual plan, bounded and allow-listed: only contract field names
 * (`knownKeys`) are emitted, each with its JSON type. Any other key is never echoed; it is
 * counted per JSON type under the fixed label "other". Scenes past the limit are counted.
 */
export function sceneShapes(value: unknown, knownKeys: ReadonlySet<string>): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`root:${jsonType(value)}`];
  const visuals = (value as { visuals?: unknown }).visuals;
  if (!Array.isArray(visuals)) return [`visuals:${jsonType(visuals)}`];
  const shapes = visuals.slice(0, SHAPE_LIMITS.scenes).map((scene, i) => {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) return `${i}:${jsonType(scene)}`;
    const known: string[] = [], other = new Map<string, number>();
    for (const [key, v] of Object.entries(scene as Record<string, unknown>)) {
      if (knownKeys.has(key)) known.push(`${key}:${jsonType(v)}`);
      else other.set(jsonType(v), (other.get(jsonType(v)) ?? 0) + 1);
    }
    if (other.size) known.push(`other:${[...other].sort().map(([t, n]) => `${t}*${n}`).join("+")}`);
    return `${i}{${known.join(",")}}`;
  });
  if (visuals.length > SHAPE_LIMITS.scenes) shapes.push(`omitted_scenes:${visuals.length - SHAPE_LIMITS.scenes}`);
  return shapes;
}

/** "code@path" with every non-index path segment outside `knownKeys` replaced by the fixed label "other". */
export function allowListedIssuePaths(error: z.ZodError, knownKeys: ReadonlySet<string>, limit = 12): string[] {
  const shown = error.issues.slice(0, limit).map(i => `${i.code}@${i.path.map(k => typeof k === "number" || knownKeys.has(String(k)) ? String(k) : "other").join(".")}`);
  return error.issues.length > limit ? [...shown, `omitted_issues:${error.issues.length - limit}`] : shown;
}

/**
 * A beat's visual plan failed validation. No scene is dropped, defaulted or invented: the whole
 * block is held back with structural diagnostics (issues + per-scene shapes, never values) so it
 * can be recovered from the committed response.
 */
export class VisualPlanBlockedError extends DocumentaryResponseError {
  readonly shapes: string[];
  constructor(issues: string[], shapes: string[]) {
    super("El plan visual de un bloque no cumple el formato; se conservan todas sus escenas y el bloque queda detenido para revisión.", issues);
    this.name = "VisualPlanBlockedError";
    this.shapes = shapes;
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
  // Capa B (response-normalizer.ts): solo envolturas sin contenido (BOM, valla con o sin salto de línea).
  try { return extractJsonDocument(text); }
  catch { throw new DocumentaryResponseError("El modelo devolvió un documento que no se pudo leer."); }
}

export function validateDocumentaryValue<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  // Capa B: solo R1 (clave desconocida vacía). Todo lo demás conserva el rechazo técnico.
  const parsed = acceptContract(schema, value);
  if (!parsed.success) {
    throw new DocumentaryResponseError("La respuesta no cumple el formato editorial requerido.", schemaIssuePaths(parsed.error));
  }
  return parsed.data;
}
