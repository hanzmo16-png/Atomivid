import { Easing } from "remotion";

/** Optional, serializable editorial controls. No provider calls or shared Reel changes. */
export type SceneDirection = {
  transition?: { type: "cut" | "dissolve"; seconds?: number };
  camera?: "still" | "push" | "pull" | "left" | "right";
  /** Source offset for video, not a timeline offset. Caller verifies source duration. */
  mediaStartSeconds?: number;
  /**
   * Optional still reframe + grade for one scene (e.g. the opening frame):
   * scale around an origin, contrast/saturation and an edge vignette.
   * Absent = the scene renders exactly as before.
   */
  look?: SceneLook;
  /**
   * Verified document with CURATED regions (from the verified record, never OCR/LLM/provider text):
   * full page → eased move to the headline → optional date/detail → back to the full page.
   */
  document?: DocumentDirection;
};
/** Only two era looks exist (no era engine): documentary colour and explicit, scoped monochrome. */
export type LookPreset = "documentary_1990s" | "schematic_mono";
export type SceneLook = {
  scale?: number;
  originX?: number;
  originY?: number;
  contrast?: number;
  saturation?: number;
  vignette?: number;
  preset?: LookPreset;
};
export type DocumentRegionLabel = "headline" | "date" | "detail";
export type DocumentRegion = { label: DocumentRegionLabel; x: number; y: number; w: number; h: number };
export type DocumentDirection = { regions: DocumentRegion[]; sourceWidth: number; sourceHeight: number };
export type SoundCue = {
  id: string;
  src: string;
  role: "music" | "ambience" | "effect";
  startSeconds: number;
  endSeconds: number;
  sourceStartSeconds?: number;
  gain?: number;
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
  loop?: boolean;
};

const clamp = (n: number) => Math.min(1, Math.max(0, n));

// --------------------------------------------------------------------------
// Shared camera: deterministic ease-in-out (Remotion's own Easing), existing caps unchanged.
// --------------------------------------------------------------------------

/** Existing caps — never raised: a push/pull/pan reaches at most 1.08; only the opening hook reaches 1.16. */
export const CAMERA_MAX_SCALE = 1.08;
export const OPENING_MAX_SCALE = 1.16;
const cameraEasing = Easing.inOut(Easing.sin);
/** Linear scene progress → eased camera progress (0→0, 0.5→0.5, 1→1; slow start and slow landing). */
export function easedProgress(progress: number): number {
  return cameraEasing(clamp(progress));
}

export function cameraTransform(camera: NonNullable<SceneDirection["camera"]>, progress: number): string {
  const p = easedProgress(progress);
  const d = CAMERA_MAX_SCALE - 1;
  switch (camera) {
    case "still": return "none";
    case "push": return `scale(${1 + d * p})`;
    case "pull": return `scale(${CAMERA_MAX_SCALE - d * p})`;
    // Overscan exceeds translation at either edge, so no black borders appear.
    case "left": return `translateX(${2 - 4 * p}%) scale(${CAMERA_MAX_SCALE})`;
    case "right": return `translateX(${-2 + 4 * p}%) scale(${CAMERA_MAX_SCALE})`;
  }
}
/** Default Ken Burns when no camera was directed: same caps as before (1.08; hook 1.16 over its first 40 %), now eased. */
export function kenBurnsTransform(progress: number, isHook: boolean): { scale: number; translateX: number } {
  if (isHook) return { scale: 1 + (OPENING_MAX_SCALE - 1) * easedProgress(Math.min(1, clamp(progress) / 0.4)), translateX: 0 };
  const p = easedProgress(progress);
  return { scale: 1 + (CAMERA_MAX_SCALE - 1) * p, translateX: -14 * p };
}

// --------------------------------------------------------------------------
// Looks: two presets only. Saturation 0 exists ONLY inside "schematic_mono".
// --------------------------------------------------------------------------

export const LOOK_PRESETS: Record<LookPreset, { contrast: number; saturation: number }> = {
  // Colour documentary grade: slightly firmer contrast, slightly calmer colour. No sepia, no degradation, no VHS.
  documentary_1990s: { contrast: 1.06, saturation: 0.9 },
  // Historical/schematic monochrome: explicit preset only (validateDirection scopes it).
  schematic_mono: { contrast: 1.08, saturation: 0 },
};

/** CSS for a SceneLook, composed after the camera move so both apply. Pure. */
export function lookStyle(look: SceneLook | undefined, cameraCss: string): { transform: string; transformOrigin?: string; filter?: string; vignette: number } {
  if (!look) return { transform: cameraCss, vignette: 0 };
  const parts = [cameraCss === "none" ? "" : cameraCss, look.scale && look.scale !== 1 ? `scale(${look.scale})` : ""].filter(Boolean);
  const preset = look.preset ? LOOK_PRESETS[look.preset] : undefined;
  const contrast = look.contrast ?? preset?.contrast;
  const saturation = look.preset === "schematic_mono" ? 0 : (look.saturation ?? preset?.saturation);
  const filters = [contrast !== undefined ? `contrast(${contrast})` : "", saturation !== undefined ? `saturate(${saturation})` : ""].filter(Boolean);
  return {
    transform: parts.length ? parts.join(" ") : "none",
    transformOrigin: look.originX !== undefined || look.originY !== undefined ? `${(look.originX ?? 0.5) * 100}% ${(look.originY ?? 0.5) * 100}%` : undefined,
    filter: filters.length ? filters.join(" ") : undefined,
    vignette: look.vignette ?? 0,
  };
}

// --------------------------------------------------------------------------
// Verified document animation over CURATED regions (deterministic, no new content)
// --------------------------------------------------------------------------

/** Hard cap shared with the existing static reframe (look.scale ≤ 1.5); also never past the source's native resolution. */
export const DOCUMENT_MAX_ZOOM = 1.5;
const DOCUMENT_LABELS: DocumentRegionLabel[] = ["headline", "date", "detail"];

export type DocumentFrame = {
  /** Uniform zoom about the frame centre, then translation in frame pixels. */
  scale: number;
  translateX: number;
  translateY: number;
  /** Highlighted region in FRAME pixels (null on the full page). */
  focus: { x: number; y: number; w: number; h: number } | null;
  /** Dimming outside the focus (0 on the full page). */
  dim: number;
  phase: "full" | DocumentRegionLabel | "move" | "exit";
};

/** The curated stops, in order: headline first, then ONE of date/detail. Missing regions are never invented. */
export function documentStops(doc: DocumentDirection): DocumentRegion[] {
  const by = (label: DocumentRegionLabel) => doc.regions.find((r) => r.label === label);
  const first = by("headline") ?? by("date") ?? by("detail");
  if (!first) return [];
  const second = first.label === "headline" ? (by("date") ?? by("detail")) : first.label === "date" ? by("detail") : undefined;
  return second ? [first, second] : [first];
}

/** Where the page sits in the frame ("contain": the whole document is visible). */
export function documentLayout(doc: DocumentDirection, frameW: number, frameH: number) {
  const s = Math.min(frameW / doc.sourceWidth, frameH / doc.sourceHeight);
  const w = doc.sourceWidth * s;
  const h = doc.sourceHeight * s;
  return { s, x: (frameW - w) / 2, y: (frameH - h) / 2, w, h, maxZoom: Math.min(DOCUMENT_MAX_ZOOM, Math.max(1, 1 / s)) };
}

function regionState(doc: DocumentDirection, r: DocumentRegion, frameW: number, frameH: number) {
  const L = documentLayout(doc, frameW, frameH);
  const box = { x: L.x + r.x * L.w, y: L.y + r.y * L.h, w: r.w * L.w, h: r.h * L.h };
  const scale = Math.min(L.maxZoom, Math.max(1, 0.82 * Math.min(frameW / box.w, frameH / box.h)));
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return { scale, translateX: -scale * (cx - frameW / 2), translateY: -scale * (cy - frameH / 2), box, dim: 0.5 };
}

/**
 * Document camera at a linear scene progress. Timeline (eased between stops):
 * one stop:  full 0–0.15 → move 0.15–0.40 → hold → exit 0.78–1.0
 * two stops: full 0–0.15 → move 0.15–0.35 → hold → move 0.55–0.70 → hold → exit 0.82–1.0
 */
export function documentFrame(doc: DocumentDirection, progress: number, frameW: number, frameH: number): DocumentFrame {
  const stops = documentStops(doc);
  const full = { scale: 1, translateX: 0, translateY: 0, box: null as DocumentFrame["focus"], dim: 0 };
  if (stops.length === 0) return { ...full, focus: null, phase: "full" };
  const states = stops.map((r) => regionState(doc, r, frameW, frameH));
  const keys: { at: number; state: typeof full; phase: DocumentFrame["phase"] }[] =
    stops.length === 1
      ? [
          { at: 0.15, state: full, phase: "full" },
          { at: 0.4, state: states[0], phase: stops[0].label },
          { at: 0.78, state: states[0], phase: stops[0].label },
          { at: 1, state: full, phase: "exit" },
        ]
      : [
          { at: 0.15, state: full, phase: "full" },
          { at: 0.35, state: states[0], phase: stops[0].label },
          { at: 0.55, state: states[0], phase: stops[0].label },
          { at: 0.7, state: states[1], phase: stops[1].label },
          { at: 0.82, state: states[1], phase: stops[1].label },
          { at: 1, state: full, phase: "exit" },
        ];
  const p = clamp(progress);
  if (p <= keys[0].at) return { ...full, focus: null, phase: "full" };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (p > b.at) continue;
    const t = easedProgress((p - a.at) / (b.at - a.at));
    const mix = (x: number, y: number) => x + (y - x) * t;
    const focusBox = b.state.box ?? a.state.box;
    const box = a.state.box && b.state.box ? { x: mix(a.state.box.x, b.state.box.x), y: mix(a.state.box.y, b.state.box.y), w: mix(a.state.box.w, b.state.box.w), h: mix(a.state.box.h, b.state.box.h) } : focusBox;
    const scale = mix(a.state.scale, b.state.scale);
    const translateX = mix(a.state.translateX, b.state.translateX);
    const translateY = mix(a.state.translateY, b.state.translateY);
    // Focus box in frame pixels after the zoom/translation (p' = C + scale·(p − C) + t).
    const focus = box ? { x: frameW / 2 + scale * (box.x - frameW / 2) + translateX, y: frameH / 2 + scale * (box.y - frameH / 2) + translateY, w: box.w * scale, h: box.h * scale } : null;
    const holding = a.state === b.state;
    return { scale, translateX, translateY, focus, dim: mix(a.state.dim, b.state.dim), phase: holding ? a.phase : b.phase === "exit" ? "exit" : "move" };
  }
  return { ...full, focus: null, phase: "exit" };
}

// --------------------------------------------------------------------------
// Curated SVG reveal: ONE path + ONE label that already exist in an approved SVG.
// --------------------------------------------------------------------------

export type CuratedSvgReveal = {
  viewBox: string;
  /** The approved SVG without the two revealed elements (drawn statically). */
  baseMarkup: string;
  path: { d: string; stroke: string; strokeWidth: number };
  label: { text: string; x: number; y: number; fontSize: number; fill: string };
};

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const escapeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "");

/**
 * Parse a CURATED SVG for the reveal. Fails closed (null) on any active content
 * or when the named path/label do not exist: the renderer never invents geometry.
 */
export function prepareCuratedSvg(markup: string, reveal: { pathId: string; labelId: string }): CuratedSvgReveal | null {
  if (/<script|<foreignObject|<image|<style|\son[a-z]+=|href=|url\(|<!ENTITY/i.test(markup)) return null;
  const root = /<svg\b[^>]*>/i.exec(markup);
  const close = markup.lastIndexOf("</svg>");
  const viewBox = root ? attr(root[0], "viewBox") : undefined;
  if (!root || close < 0 || !viewBox) return null;
  const inner = markup.slice(root.index + root[0].length, close);
  const pathTag = new RegExp(`<path\\b[^>]*\\sid="${escapeId(reveal.pathId)}"[^>]*/>`).exec(inner)?.[0];
  const labelMatch = new RegExp(`<text\\b([^>]*\\sid="${escapeId(reveal.labelId)}"[^>]*)>([^<]*)</text>`).exec(inner);
  const d = pathTag ? attr(pathTag, "d") : undefined;
  if (!pathTag || !d || !labelMatch || !labelMatch[2].trim()) return null;
  const labelTag = ` ${labelMatch[1]}`;
  const x = Number(attr(labelTag, "x"));
  const y = Number(attr(labelTag, "y"));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    viewBox,
    baseMarkup: inner.replace(pathTag, "").replace(labelMatch[0], ""),
    path: { d, stroke: attr(pathTag, "stroke") ?? "#e24b4b", strokeWidth: Number(attr(pathTag, "stroke-width") ?? 6) || 6 },
    label: { text: labelMatch[2].trim(), x, y, fontSize: Number(attr(labelTag, "font-size") ?? 40) || 40, fill: attr(labelTag, "fill") ?? "#ffffff" },
  };
}

/** Deterministic reveal: the path draws 0.10–0.65 (eased), the label fades in 0.65–0.80. */
export function svgRevealState(progress: number): { pathDrawn: number; labelOpacity: number } {
  const p = clamp(progress);
  return { pathDrawn: easedProgress((p - 0.1) / 0.55), labelOpacity: easedProgress((p - 0.65) / 0.15) };
}

// --------------------------------------------------------------------------
// Safe areas: the same composition in 16:9 and 9:16 (no Reels-specific copy of the rules).
// --------------------------------------------------------------------------

export type SafeAreas = { top: number; side: number; bottom: number; captionMaxWidth: number; captionFontSize: number; labelFontSize: number };
export function safeAreas(width: number, height: number): SafeAreas {
  if (height <= width) return { top: 44, side: 56, bottom: 120, captionMaxWidth: 1400, captionFontSize: 46, labelFontSize: 28 };
  // Vertical: clear the platform chrome (top status/title band, bottom actions/description band).
  const side = Math.round(width * 0.07);
  return { top: Math.round(height * 0.085), side, bottom: Math.round(height * 0.2), captionMaxWidth: width - 2 * side, captionFontSize: Math.round(width * 0.048), labelFontSize: Math.round(width * 0.03) };
}
export function transitionFrames(direction: SceneDirection | undefined, fps: number, duration: number): number {
  if (!direction) return Math.min(15, Math.floor(duration * fps / 2));
  if (direction.transition?.type !== "dissolve") return 0;
  return Math.max(0, Math.round(Math.min(direction.transition.seconds ?? 0.3, duration / 2) * fps));
}

/** Entire non-voice bus has a conservative amplitude cap, including overlaps. */
export function soundCueVolume(cue: SoundCue, t: number, all: SoundCue[], gaps: {startSeconds: number; endSeconds: number}[]): number {
  const raw = (c: SoundCue) => {
    if (t < c.startSeconds || t >= c.endSeconds) return 0;
    const fadeIn = c.fadeInSeconds ?? (c.role === "effect" ? 0.02 : 0.6);
    const fadeOut = c.fadeOutSeconds ?? (c.role === "effect" ? 0.08 : 0.6);
    const envelope = Math.min(fadeIn === 0 ? 1 : clamp((t - c.startSeconds) / fadeIn), fadeOut === 0 ? 1 : clamp((c.endSeconds - t) / fadeOut));
    // Rise only INSIDE a known narration gap; stay ducked as speech resumes.
    const gapFactor = gaps.reduce((peak, g) => Math.max(peak, Math.min(clamp((t - g.startSeconds) / 0.2), clamp((g.endSeconds - t) / 0.2))), 0);
    const base = c.role === "music" ? 0.10 : c.role === "ambience" ? 0.06 : 0.12;
    return envelope * (c.gain ?? 1) * base * (1 + gapFactor);
  };
  const sum = all.reduce((v, c) => v + raw(c), 0);
  return raw(cue) * (sum > 0.28 ? 0.28 / sum : 1);
}

export function validateDirection(
  scenes: {id: string; startSeconds: number; endSeconds: number; direction?: SceneDirection; provenance?: string; asset?: {kind: string; mediaType?: string; graphic?: {kind: string}}}[],
  cues: SoundCue[] | undefined,
  duration: number,
): void {
  const finite = (n: number) => Number.isFinite(n);
  for (const s of scenes) {
    const d = s.direction;
    if (!d) continue;
    if (d.camera && !["still", "push", "pull", "left", "right"].includes(d.camera)) throw new Error(`Invalid camera: ${s.id}`);
    if (d.transition && !["cut", "dissolve"].includes(d.transition.type)) throw new Error(`Invalid transition: ${s.id}`);
    if (d.transition?.seconds !== undefined && (!finite(d.transition.seconds) || d.transition.seconds < 0 || d.transition.seconds > 1)) throw new Error(`Invalid transition duration: ${s.id}`);
    if (d.mediaStartSeconds !== undefined && (!finite(d.mediaStartSeconds) || d.mediaStartSeconds < 0)) throw new Error(`Invalid media offset: ${s.id}`);
    if (d.look) {
      const within = (v: number | undefined, lo: number, hi: number) => v === undefined || (finite(v) && v >= lo && v <= hi);
      const l = d.look;
      // Conservative bounds: a reframe/grade, never a different picture.
      if (!within(l.scale, 1, 1.5) || !within(l.originX, 0, 1) || !within(l.originY, 0, 1) || !within(l.contrast, 0.8, 1.4) || !within(l.saturation, 0.6, 1.5) || !within(l.vignette, 0, 0.8)) {
        throw new Error(`Invalid look: ${s.id}`);
      }
      if (l.preset !== undefined && !(l.preset in LOOK_PRESETS)) throw new Error(`Invalid look preset: ${s.id}`);
      // Era looks only grade verified archive (or, for mono, a curated schematic SVG): never disguise other material as period.
      const curatedSvg = s.asset?.kind === "graphic" && s.asset.graphic?.kind === "curated_svg";
      if (l.preset === "documentary_1990s" && s.provenance !== "archival_documentary") throw new Error(`Era look on non-archival scene: ${s.id}`);
      if (l.preset === "schematic_mono" && !(s.provenance === "archival_documentary" || curatedSvg)) throw new Error(`Monochrome on non-archival scene: ${s.id}`);
    }
    if (d.document) {
      const doc = d.document;
      if (s.provenance !== "archival_documentary" || (s.asset && !(s.asset.kind === "media" && s.asset.mediaType === "image"))) throw new Error(`Document animation needs a verified archival image: ${s.id}`);
      if (!finite(doc.sourceWidth) || !finite(doc.sourceHeight) || doc.sourceWidth <= 0 || doc.sourceHeight <= 0 || !Array.isArray(doc.regions) || doc.regions.length === 0) throw new Error(`Invalid document: ${s.id}`);
      for (const r of doc.regions) {
        if (!DOCUMENT_LABELS.includes(r.label) || ![r.x, r.y, r.w, r.h].every((v) => finite(v) && v >= 0 && v <= 1) || r.w <= 0 || r.h <= 0 || r.x + r.w > 1 + 1e-9 || r.y + r.h > 1 + 1e-9) throw new Error(`Invalid document region: ${s.id}`);
      }
    }
  }
  const ids = new Set<string>();
  for (const c of cues ?? []) {
    if (!c.id || ids.has(c.id) || !c.src.trim()) throw new Error("Missing/duplicate sound cue identity or source");
    ids.add(c.id);
    if (!["music", "ambience", "effect"].includes(c.role)) throw new Error(`Invalid sound role: ${c.id}`);
    if (![c.startSeconds, c.endSeconds].every(finite) || c.startSeconds < 0 || c.endSeconds <= c.startSeconds || c.endSeconds > duration) throw new Error(`Invalid sound timing: ${c.id}`);
    for (const value of [c.sourceStartSeconds, c.fadeInSeconds, c.fadeOutSeconds]) if (value !== undefined && (!finite(value) || value < 0)) throw new Error(`Invalid sound offset/fade: ${c.id}`);
    if (c.gain !== undefined && (!finite(c.gain) || c.gain < 0 || c.gain > 2)) throw new Error(`Invalid sound gain: ${c.id}`);
    if (c.loop !== undefined && typeof c.loop !== "boolean") throw new Error(`Invalid sound loop: ${c.id}`);
  }
}
