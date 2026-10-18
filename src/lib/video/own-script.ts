/**
 * «Usar mi propio guion» for a Reel. The customer's text is stored at creation as a script-shaped draft
 * (scenes = the text split at sentence boundaries, words untouched) so it survives every failure; the first
 * paid step only adds the visual fields of each scene (planOwnScript in ai/script.ts), and the narration
 * is copied back from this draft, never from the model.
 *
 * Until those visuals exist the draft is NOT a renderable script: hasRenderableScript() is what the
 * render route and the history/result buttons use to choose between «preparar escenas» and the render.
 */
import { fitForDuration, narrationStats, normalizeNarration, splitIntoScenes, type DurationFit } from "./narration-fit";
import { availableVideoDurations } from "./avatar/duration";

export type ScriptSource = "generated" | "own" | "adapt";
export type OwnScriptDraft = {
  title: string;
  segments: { text: string; visualQuery: string }[];
  source: "own" | "adapt";
  /** false until the scene-planning call filled the visuals. */
  visualsPlanned: false;
  /** The text exactly as accepted (normalised whitespace only). */
  ownText: string;
};

export function buildOwnScriptDraft(text: string, title: string, durationSeconds: number, source: "own" | "adapt" = "own"): OwnScriptDraft {
  const ownText = normalizeNarration(text);
  return { title: title.slice(0, 120), segments: splitIntoScenes(ownText, durationSeconds).map(s => ({ text: s, visualQuery: "" })), source, visualsPlanned: false, ownText };
}

export function isOwnScriptDraft(json: unknown): json is OwnScriptDraft {
  const j = json as Partial<OwnScriptDraft> | null;
  return Boolean(j && typeof j === "object" && (j.source === "own" || j.source === "adapt") && j.visualsPlanned === false && typeof j.ownText === "string");
}

/**
 * The meaning «has a script» always had (any stored script: Reel/Avatar segments, Long Form beats, the
 * recording placeholder), minus an own-script draft still waiting for its visuals.
 */
export function hasRenderableScript(json: unknown): boolean {
  return Boolean(json) && !isOwnScriptDraft(json);
}

/**
 * Server-side fit of a stored own script (the same function the form shows live). «adapt» has no fit: the
 * AI adapts it to the duration and the worker still measures the audio.
 */
export function draftFit(draft: OwnScriptDraft, durationSeconds: number, language: string | null | undefined): DurationFit | null {
  if (draft.source !== "own") return null;
  return fitForDuration(narrationStats(draft.ownText, language === "en" ? "en" : "es", "visual"), durationSeconds, availableVideoDurations("visual", 0));
}

/** Source of a stored script, for labels and for keeping own narration untouched later. */
export function scriptSourceOf(json: unknown): ScriptSource {
  const s = (json as { source?: unknown } | null)?.source;
  return s === "own" || s === "adapt" ? s : "generated";
}

/** The narration of a planned script is the draft's, verbatim: true when every scene text matches in order. */
export function narrationPreserved(draft: OwnScriptDraft, script: { segments: { text: string }[] }): boolean {
  return script.segments.length === draft.segments.length && script.segments.every((s, i) => s.text === draft.segments[i].text);
}
