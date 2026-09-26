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
};
export type SceneLook = {
  scale?: number;
  originX?: number;
  originY?: number;
  contrast?: number;
  saturation?: number;
  vignette?: number;
};
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
export function cameraTransform(camera: NonNullable<SceneDirection["camera"]>, progress: number): string {
  const p = clamp(progress);
  switch (camera) {
    case "still": return "none";
    case "push": return `scale(${1 + 0.08 * p})`;
    case "pull": return `scale(${1.08 - 0.08 * p})`;
    // Overscan exceeds translation at either edge, so no black borders appear.
    case "left": return `translateX(${2 - 4 * p}%) scale(1.08)`;
    case "right": return `translateX(${-2 + 4 * p}%) scale(1.08)`;
  }
}
/** CSS for a SceneLook, composed after the camera move so both apply. Pure. */
export function lookStyle(look: SceneLook | undefined, cameraCss: string): { transform: string; transformOrigin?: string; filter?: string; vignette: number } {
  if (!look) return { transform: cameraCss, vignette: 0 };
  const parts = [cameraCss === "none" ? "" : cameraCss, look.scale && look.scale !== 1 ? `scale(${look.scale})` : ""].filter(Boolean);
  const filters = [look.contrast !== undefined ? `contrast(${look.contrast})` : "", look.saturation !== undefined ? `saturate(${look.saturation})` : ""].filter(Boolean);
  return {
    transform: parts.length ? parts.join(" ") : "none",
    transformOrigin: look.originX !== undefined || look.originY !== undefined ? `${(look.originX ?? 0.5) * 100}% ${(look.originY ?? 0.5) * 100}%` : undefined,
    filter: filters.length ? filters.join(" ") : undefined,
    vignette: look.vignette ?? 0,
  };
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
  scenes: {id: string; startSeconds: number; endSeconds: number; direction?: SceneDirection}[],
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
