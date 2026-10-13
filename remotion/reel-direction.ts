/**
 * Per-scene direction for VerticalReel (optional, backward compatible). A scene WITHOUT `direction` keeps the
 * historic look exactly (Ken Burns on every scene, hook zoom on the first, 0.5 s crossfades). A scene WITH
 * `direction` comes from a Director plan (the Director bridge in src/lib/video/director/) and its recipe decides:
 *  - motion:   static (no camera move), push_in (declared zoom on a still), pan (declared lateral move on a still),
 *              real (a real clip plays as filmed: no synthetic zoom on top), hook (the historic opening zoom);
 *  - transitions at each boundary: cut, crossfade (0.5 s overlap) or fade (from/to black, no overlap);
 *  - label: a visible badge for AI recreations / illustrative material, drawn at the top-left, away from captions;
 *    `labelText` may override the wording (e.g. «Ficción creada con IA»), never remove a required label;
 *  - audio: "clip" keeps the clip's own sound (e.g. generated sound design); absent or "muted" = historic behaviour
 *    (every clip muted; only narration and music are heard).
 * Pure functions only, so the frame math is unit-tested without rendering.
 */
export type SceneMotion = "static" | "push_in" | "pan" | "real" | "hook";
export type SceneTransitionIn = "cut" | "crossfade" | "fade";
export type SceneTransitionOut = "cut" | "crossfade" | "fade";
export type SceneLabel = "recreacion_ia" | "ilustrativa";

export type SceneDirection = {
  /** Recipe that produced this scene (traceability only; not drawn). */
  recipeId?: string | null;
  motion: SceneMotion;
  transitionIn: SceneTransitionIn;
  transitionOut: SceneTransitionOut;
  label?: SceneLabel | null;
  /** Visible wording of the label; defaults to LABEL_TEXT[label]. */
  labelText?: string | null;
  /** "clip" plays the clip's own audio track; default muted (historic). */
  audio?: "clip" | "muted";
};

export const FADE_FRAMES = 15; // 0.5 s at 30 fps (historic crossfade)
export const DIP_FRAMES = 9; // 0.3 s fade from/to black

export const LABEL_TEXT: Record<SceneLabel, string> = { recreacion_ia: "Recreación IA", ilustrativa: "Imagen ilustrativa" };

type Dir = SceneDirection | undefined;

/** A boundary crossfades when either side asks for it; legacy scenes (no direction) always crossfade. */
export function crossfadeAt(prev: Dir, next: Dir): boolean {
  if (!prev || !next) return true;
  return prev.transitionOut === "crossfade" || next.transitionIn === "crossfade";
}

export type SceneTiming = { from: number; durationInFrames: number; overlapIn: number; overlapOut: number; dipIn: number; dipOut: number };

/** Frame window of scene i: overlaps only at crossfade boundaries; dips (fade from/to black) stay inside the scene. */
export function sceneTiming(scenes: { startSeconds: number; endSeconds: number; direction?: SceneDirection }[], i: number, fps: number, totalFrames: number): SceneTiming {
  const s = scenes[i], isFirst = i === 0, isLast = i === scenes.length - 1;
  const from = Math.round(s.startSeconds * fps);
  const rawTo = isLast ? totalFrames : Math.round(s.endSeconds * fps);
  const overlapOut = !isLast && crossfadeAt(s.direction, scenes[i + 1].direction) ? FADE_FRAMES : 0;
  const overlapIn = !isFirst && crossfadeAt(scenes[i - 1].direction, s.direction) ? FADE_FRAMES : 0;
  const to = Math.min(totalFrames, rawTo + overlapOut);
  const durationInFrames = Math.max(1, to - from);
  const dipIn = s.direction?.transitionIn === "fade" && !overlapIn ? Math.min(DIP_FRAMES, Math.floor(durationInFrames / 3)) : 0;
  const dipOut = s.direction?.transitionOut === "fade" && !overlapOut ? Math.min(DIP_FRAMES, Math.floor(durationInFrames / 3)) : 0;
  return { from, durationInFrames, overlapIn, overlapOut, dipIn, dipOut };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp01(t);

/** Opacity of a scene at local frame f (crossfade overlaps and dips to black). */
export function sceneOpacity(t: SceneTiming, f: number): number {
  let o = 1;
  const fadeIn = t.overlapIn || t.dipIn, fadeOut = t.overlapOut || t.dipOut;
  if (fadeIn > 0) o = Math.min(o, clamp01(f / fadeIn));
  if (fadeOut > 0) o = Math.min(o, clamp01((t.durationInFrames - f) / fadeOut));
  return o;
}

/** Camera transform of a scene at progress p (0..1). Legacy scenes keep the historic Ken Burns / hook curve. */
export function sceneTransform(direction: SceneDirection | undefined, isFirst: boolean, p: number): { scale: number; translateX: number } {
  const motion: SceneMotion = direction ? direction.motion : isFirst ? "hook" : "legacy" as SceneMotion;
  switch (motion) {
    case "hook": return { scale: lerp(1, 1.22, p / 0.4), translateX: 0 };
    case "static": case "real": return { scale: 1, translateX: 0 };
    case "push_in": return { scale: lerp(1, 1.15, p), translateX: 0 };
    case "pan": return { scale: 1.12, translateX: lerp(40, -40, p) };
    default: return { scale: lerp(1, 1.12, p), translateX: lerp(0, -18, p) }; // legacy Ken Burns
  }
}

/** Whether a scene's clip is heard. Only an explicit "clip" direction on a video unmutes it; everything else stays muted. */
export function clipAudible(direction: SceneDirection | undefined, mediaType: "image" | "video"): boolean {
  return mediaType === "video" && direction?.audio === "clip";
}

/** Visible label text for a scene (null when the scene carries no label). */
export function labelTextFor(direction: SceneDirection | undefined): string | null {
  if (!direction?.label) return null;
  return direction.labelText?.trim() || LABEL_TEXT[direction.label];
}
