/** Production ladder: methods ordered from cheapest to most expensive. */
export const METHODS = [
  "EXISTING_APPROVED_ASSET",
  "STOCK",
  "AI_STILL",
  "STILL_KEN_BURNS",
  "STILL_PARALLAX",
  "I2V_ECONOMY",
  "I2V_HERO",
] as const;
export type Method = (typeof METHODS)[number];

export const GENERATIVE_VIDEO_METHODS: readonly Method[] = ["I2V_ECONOMY", "I2V_HERO"];

export function isGenerativeVideo(m: Method): boolean {
  return GENERATIVE_VIDEO_METHODS.includes(m);
}

/** Still-based methods need an approved still first (state machine enforces it). */
export function needsStill(m: Method): boolean {
  return m === "AI_STILL" || m === "STILL_KEN_BURNS" || m === "STILL_PARALLAX" || isGenerativeVideo(m);
}

/** Does the method deliver on-screen motion (camera or generated)? */
export function motionOf(m: Method): "none" | "camera" | "generated" {
  if (isGenerativeVideo(m)) return "generated";
  if (m === "STILL_KEN_BURNS" || m === "STILL_PARALLAX") return "camera";
  if (m === "STOCK" || m === "EXISTING_APPROVED_ASSET") return "camera"; // footage/reused clips carry their own motion
  return "none";
}

export function ladderIndex(m: Method): number {
  return METHODS.indexOf(m);
}
