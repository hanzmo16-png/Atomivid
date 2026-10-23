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
  const json = text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  try { return JSON.parse(json); }
  catch { throw new DocumentaryResponseError("El modelo devolvió un documento que no se pudo leer."); }
}

/** A value that carries no information: null/undefined or a blank string. An empty array or object is NOT
 * treated as empty: in a repair contract `findings: []` can mean "clear the findings", which must keep failing. */
function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function objectAt(root: unknown, path: readonly PropertyKey[]): Record<string, unknown> | null {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") return null;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node !== null && typeof node === "object" && !Array.isArray(node) ? node as Record<string, unknown> : null;
}

/**
 * The ONE lossless normalisation applied before accepting a model's JSON document (incident 23d86d0a,
 * 2026-10-23: the opening-payoff check answered with every required field valid plus an extra
 * `evidence.explanation: ""`, and a `.strict()` contract turned a correct, paid answer into a
 * terminal failure).
 *
 * Contracts here are prompt-only (no provider-side grammar), so harmless shape noise is expected.
 * Exactly one class is recoverable: a key the schema does NOT recognise whose value is null or a blank
 * string (see isEmptyValue). It carries no information, so removing it cannot change meaning. Everything else
 * still fails exactly as before: missing or mistyped fields, out-of-range values, unknown enum labels
 * and unknown keys WITH content (possibly misplaced content). The schema decides which keys are
 * unknown, so a recognised nullable field (e.g. `commentMoment: null`) is never touched. The input is
 * not mutated; the committed raw response in the ledger stays byte-identical for audit and replay.
 */
export function normalizeRecoverableFormat<T extends z.ZodType>(schema: T, value: unknown): { value: unknown; removed: string[] } {
  let current = value;
  const removed: string[] = [];
  for (let round = 0; round < 8; round++) {
    const parsed = schema.safeParse(current);
    if (parsed.success) break;
    let changed = false;
    for (const issue of parsed.error.issues) {
      if (issue.code !== "unrecognized_keys") continue;
      if (current === value) current = structuredClone(value);
      const target = objectAt(current, issue.path);
      if (!target) continue;
      for (const key of (issue as { keys: string[] }).keys) {
        if (Object.prototype.hasOwnProperty.call(target, key) && isEmptyValue(target[key])) {
          delete target[key];
          removed.push([...issue.path.map(String), "*"].join("."));
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return { value: current, removed };
}

/** Schema check after the lossless normalisation; logs only structural paths (never key names or values). */
export function acceptDocumentaryValue<T extends z.ZodType>(schema: T, value: unknown) {
  const normalized = normalizeRecoverableFormat(schema, value);
  if (normalized.removed.length) console.warn("[atomivid:documentary-format-normalized]", JSON.stringify(normalized.removed.slice(0, 12)));
  return schema.safeParse(normalized.value);
}

export function validateDocumentaryValue<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = acceptDocumentaryValue(schema, value);
  if (!parsed.success) {
    throw new DocumentaryResponseError("La respuesta no cumple el formato editorial requerido.", schemaIssuePaths(parsed.error));
  }
  return parsed.data;
}
