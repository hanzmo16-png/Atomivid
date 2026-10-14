import { parseVisualPlan, VISUAL_DIAGNOSTIC_KEYS } from "./documentary-script";
import { DocumentaryResponseError, VisualPlanBlockedError, SHAPE_LIMITS, sceneShapes } from "./json-response";
import { narrationCatalog } from "./narration-catalog";
import { locateNormalized } from "./text-locate";
import { countWords } from "./duration-budget";

type Beat = Parameters<typeof narrationCatalog>[0][number];
type ResponseLike = { stop_reason: string | null; content: Array<{ type: string; text?: string }> };

/** Rejected analyzer input. The message is a fixed code: never file content, paths or parser detail. */
export class AnalyzerInputError extends Error {
  constructor(readonly code: "response_invalid" | "narration_invalid" | "beat_out_of_range") {
    super(`analyzer input rejected: ${code}`);
    this.name = "AnalyzerInputError";
  }
}

export type VisualPlanAnalysis = {
  /** Schema check only (same all-or-nothing acceptance as the pipeline). NOT an editorial or production approval. */
  schema: "valid" | "invalid";
  editorialApproval: "not_evaluated";
  /** Allow-listed "code@path" issues (no values, no unknown key names). */
  issues: string[];
  /** Bounded per-scene contract keys with JSON types (unknown keys only counted by type). */
  shapes: string[];
  scenes: number;
  /** First scenes only (see omittedScenes): schema validity and anchor, as the pipeline would resolve it. */
  anchors: Array<{ scene: number; valid: boolean; excerptId: "absent" | "not_string" | "resolved" | "unknown"; anchor: "excerpt" | "quote" | "none"; id?: string }>;
  omittedScenes: number;
  /** Scenes that fail the acceptance schema on their own (first indices; invalidSceneCount is the total). */
  invalidScenes: number[];
  invalidSceneCount: number;
  /** Where unresolved excerptIds point, as counts: another narration revision, another beat, or not a catalog id. */
  unresolvedExcerptIds: { otherRevision: number; otherBeat: number; notCatalogFormat: number };
  duplicateExcerptIds: string[];
  /** Reproduction of the pipeline's post-parse anchoring (excerptId, else a locatable quote of ≥5 words; minimum 2). Diagnostic only. */
  pipelineAnchoring: { anchoredValidScenes: number; minimumRequired: 2; meetsMinimum: boolean };
  catalogExcerpts: number;
  /** Catalog excerpts referenced by VALID scenes only. A reference count, not semantic or editorial coverage. */
  coveredExcerpts: number;
  uncoveredExcerptIds: string[];
};

/** Accepts a stored model message ({stop_reason, content}) or the bare plan JSON ({visuals}). */
export function asResponse(stored: unknown): ResponseLike {
  if (stored && typeof stored === "object" && Array.isArray((stored as ResponseLike).content)) return stored as ResponseLike;
  return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(stored) }] };
}

/** Beats as the catalog needs them: every narration a string of at least five words. */
export function validBeats(value: unknown): Beat[] {
  const beats = Array.isArray(value) ? value : value && typeof value === "object" ? (value as { beats?: unknown }).beats : undefined;
  if (!Array.isArray(beats) || !beats.length) throw new AnalyzerInputError("narration_invalid");
  for (const beat of beats) {
    const narration = beat && typeof beat === "object" ? (beat as { narration?: unknown }).narration : undefined;
    if (typeof narration !== "string" || (narration.match(/\S+/g)?.length ?? 0) < 5) throw new AnalyzerInputError("narration_invalid");
  }
  return beats as Beat[];
}

/**
 * Offline, read-only diagnosis of one beat's visual plan against the approved narration.
 * Pure: no network, no provider, no writes; it never returns narration, quotes, descriptions or unknown keys.
 */
export function analyzeVisualPlan(stored: unknown, beatsInput: unknown, beatIndex: number, opts: { cinematic: boolean; referenceContract: boolean }): VisualPlanAnalysis {
  const beats = validBeats(beatsInput);
  if (!Number.isInteger(beatIndex) || beatIndex < 0 || beatIndex >= beats.length) throw new AnalyzerInputError("beat_out_of_range");
  const response = asResponse(stored);
  let schema: VisualPlanAnalysis["schema"] = "valid";
  let issues: string[] = [];
  let value: unknown;
  try { value = JSON.parse(response.content.filter(b => b.type === "text").map(b => b.text ?? "").join("").trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1")); }
  catch { value = undefined; }
  try { parseVisualPlan(response, opts); }
  catch (error) {
    if (!(error instanceof DocumentaryResponseError)) throw error;
    schema = "invalid";
    issues = error instanceof VisualPlanBlockedError ? error.issues : ["unreadable@response"];
  }
  const all = narrationCatalog(beats);
  const revision = all[0].id.split(":")[0];
  const catalog = new Map(all.filter(e => e.beatIndex === beatIndex).map(e => [e.id, e]));
  const narration = beats[beatIndex].narration;
  const visuals = value && typeof value === "object" && Array.isArray((value as { visuals?: unknown }).visuals) ? (value as { visuals: unknown[] }).visuals : [];
  const valid = (scene: unknown) => { try { parseVisualPlan(asResponse({ visuals: [scene] }), opts); return true; } catch { return false; } };
  const unresolved = { otherRevision: 0, otherBeat: 0, notCatalogFormat: 0 };
  const scenes = visuals.map((scene, i) => {
    const fields = scene && typeof scene === "object" && !Array.isArray(scene) ? scene as Record<string, unknown> : {};
    const id = fields.excerptId, quote = fields.quote, isValid = valid(scene);
    const excerptId = id === undefined ? "absent" as const : typeof id !== "string" ? "not_string" as const : catalog.has(id) ? "resolved" as const : "unknown" as const;
    if (excerptId === "unknown") {
      const m = /^([0-9a-f]{16}):b(\d+):w\d+$/.exec(id as string);
      if (!m) unresolved.notCatalogFormat++; else if (m[1] !== revision) unresolved.otherRevision++; else unresolved.otherBeat++;
    }
    // Same order as the pipeline: the catalog excerpt, else a passage located in this beat's narration.
    const located = excerptId === "resolved" ? catalog.get(id as string)!.quote : typeof quote === "string" && quote ? locateNormalized(narration, quote) : null;
    const anchor = located && countWords(located) >= 5 ? (excerptId === "resolved" ? "excerpt" as const : "quote" as const) : "none" as const;
    return { scene: i, valid: isValid, excerptId, anchor, ...(excerptId === "resolved" ? { id: id as string } : {}) };
  });
  const seen = new Map<string, number>();
  for (const s of scenes) if (s.id) seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
  const covered = new Set(scenes.filter(s => s.valid && s.anchor === "excerpt").map(s => s.id!));
  const invalid = scenes.filter(s => !s.valid).map(s => s.scene);
  const anchoredValidScenes = scenes.filter(s => s.valid && s.anchor !== "none").length;
  return {
    schema, editorialApproval: "not_evaluated", issues, shapes: sceneShapes(value, VISUAL_DIAGNOSTIC_KEYS), scenes: visuals.length,
    anchors: scenes.slice(0, SHAPE_LIMITS.scenes), omittedScenes: Math.max(0, scenes.length - SHAPE_LIMITS.scenes),
    invalidScenes: invalid.slice(0, SHAPE_LIMITS.scenes), invalidSceneCount: invalid.length,
    unresolvedExcerptIds: unresolved,
    duplicateExcerptIds: [...seen].filter(([, n]) => n > 1).map(([id]) => id),
    pipelineAnchoring: { anchoredValidScenes, minimumRequired: 2, meetsMinimum: anchoredValidScenes >= 2 },
    catalogExcerpts: catalog.size, coveredExcerpts: covered.size,
    uncoveredExcerptIds: [...catalog.keys()].filter(id => !covered.has(id)),
  };
}
