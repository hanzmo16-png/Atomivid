import { RECRAFT_USD_PER_IMAGE, RECRAFT_USD_STYLE_CREATION, isValidStyleId } from "@/lib/providers/image/recraft";
export { isValidStyleId };
import type { ScriptScene } from "@/lib/providers/types";

/**
 * «Imágenes IA con Recraft» for a Reel: a per-video, explicit choice of the creator. Pure (no I/O).
 * The style comes ONLY from what the user gave for THIS video (a saved style_id or 1-10 reference images, plus an
 * optional free-text note). There is no house aesthetic: nothing «Roman/ancient» or otherwise is ever added.
 */
export type ReelImageSource = "default" | "recraft";
export type ReelRecraftStyle = {
  /** A Recraft V4 style id given by the user, or null when the style is created from the reference images. */
  styleId: string | null;
  /** Storage paths (our bucket) of the user's reference images, 0 when styleId is given. */
  referencePaths: string[];
  match: "precise" | "flexible" | null;
  /** Optional user note appended to every prompt (their words only). */
  styleNote: string | null;
  /**
   * If fal creates the style but returns no style_id (optional in its schema): "stop" (default) keeps the paid image
   * and request id and requests no further image until someone decides; "same_references" continues sending the SAME
   * references and match for every image (each may create its style again: estimated at +USD 0.005 per image).
   */
  onMissingStyleId: "stop" | "same_references";
};

export const RECRAFT_MAX_REFERENCES = 10;
export const RECRAFT_MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
export const RECRAFT_REFERENCE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export type RecraftSelectionInput = {
  source: unknown; styleId: unknown; match: unknown; styleNote: unknown; referenceCount: number; onMissingStyleId?: unknown;
};

/** Server-side validation of the form choice. Returns an error message (Spanish, user-facing) or the normalized choice. */
export function parseRecraftSelection(input: RecraftSelectionInput, enabled: boolean):
  { source: "default" } | { source: "recraft"; styleId: string | null; match: ReelRecraftStyle["match"]; styleNote: string | null; onMissingStyleId: ReelRecraftStyle["onMissingStyleId"] } | { error: string } {
  const source = String(input.source ?? "default").trim() || "default";
  if (source === "default") return { source: "default" };
  if (source !== "recraft") return { error: "Fuente de imágenes no válida." };
  if (!enabled) return { error: "Las imágenes IA con Recraft no están disponibles para esta cuenta todavía. No se ha creado ni cobrado nada." };
  const styleId = String(input.styleId ?? "").trim();
  if (styleId && !isValidStyleId(styleId)) return { error: "El style_id de Recraft no es válido (no uses un request_id de fal.ai). No se ha creado ni cobrado nada." };
  if (!styleId && input.referenceCount < 1) return { error: "Para Recraft indica un style_id o sube entre 1 y 10 imágenes de referencia de estilo." };
  if (input.referenceCount > RECRAFT_MAX_REFERENCES) return { error: "Recraft admite como máximo 10 imágenes de referencia." };
  const m = String(input.match ?? "").trim();
  const match = m === "precise" || m === "flexible" ? m : null;
  const note = String(input.styleNote ?? "").trim().slice(0, 300);
  return { source: "recraft", styleId: styleId || null, match, styleNote: note || null,
    onMissingStyleId: input.onMissingStyleId === "same_references" ? "same_references" : "stop" };
}

/** Estimated provider cost of the Recraft images of one Reel: one image per scene, plus style creation once — or once
 * per image when the video keeps sending its references because fal returned no style_id ("same_references"). */
export function recraftReelEstimateUsd(sceneCount: number, hasStyleId: boolean, onMissingStyleId: ReelRecraftStyle["onMissingStyleId"] = "stop"): number {
  if (!Number.isInteger(sceneCount) || sceneCount < 0) throw new Error("scene count invalid");
  if (sceneCount === 0) return 0;
  const creations = hasStyleId ? 0 : onMissingStyleId === "same_references" ? sceneCount : 1;
  return Math.round((sceneCount * RECRAFT_USD_PER_IMAGE + creations * RECRAFT_USD_STYLE_CREATION) * 10_000) / 10_000;
}

/** Prompt for one scene: the storyboard prompt when present, else the scene's own visual description. User note only. */
export function recraftScenePrompt(segment: Pick<ScriptScene, "text" | "visualQuery" | "visualConcepts">, storyboardPrompt: string | undefined, styleNote: string | null): string {
  const base = storyboardPrompt?.trim()
    || [segment.visualQuery, ...(segment.visualConcepts ?? []).slice(0, 2)].filter(Boolean).join("; ")
    || segment.text;
  const prompt = `${base}. Vertical 9:16 composition, no text, no watermark.`;
  return styleNote ? `${prompt} ${styleNote}` : prompt;
}

export function parseStoredRecraftStyle(raw: unknown): ReelRecraftStyle | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const styleId = typeof r.styleId === "string" && isValidStyleId(r.styleId) ? r.styleId : null;
  const referencePaths = Array.isArray(r.referencePaths) ? r.referencePaths.filter((p): p is string => typeof p === "string").slice(0, RECRAFT_MAX_REFERENCES) : [];
  if (!styleId && referencePaths.length === 0) return null;
  const match = r.match === "precise" || r.match === "flexible" ? r.match : null;
  const styleNote = typeof r.styleNote === "string" && r.styleNote.trim() ? r.styleNote.trim().slice(0, 300) : null;
  return { styleId, referencePaths, match, styleNote, onMissingStyleId: r.onMissingStyleId === "same_references" ? "same_references" : "stop" };
}

/** Customer-safe stop: fal created the style for this video but returned no style_id, and the video's policy is "stop".
 * The paid image and its fal request id are kept (reused on retry, never regenerated); no other image is requested. */
export class RecraftStyleMissingError extends Error {
  readonly customerMessage: string;
  readonly retryable = false;
  constructor(readonly providerJobId?: string) {
    const text = "Recraft creó el estilo de este video pero no devolvió su identificador (style_id). La imagen pagada y su solicitud se conservaron; no se pidió ninguna otra imagen para no mezclar estilos. Soporte revisa el caso; reintentar no lo cambia.";
    super(text);
    this.name = "RecraftStyleMissingError";
    this.customerMessage = text;
  }
}
