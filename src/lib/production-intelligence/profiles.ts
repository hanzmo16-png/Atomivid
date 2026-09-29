/**
 * Versioned production profiles. Each format owns its limits; Long Form rules
 * never leak into Short Form or Avatar (each profile is self-contained data).
 */
import type { Method } from "./ladder";
import type { QualityTier, ShotClass } from "./contract";

export type ProductionProfile = {
  id: "SHORT_9X16" | "LONGFORM_16X9" | "AVATAR";
  profileVersion: string;
  aspect: "9:16" | "16:9";
  allowedMethods: Method[];
  forbiddenMethods: Method[];
  /** Global generative video budget: billed generated seconds per finished minute, plus an absolute cap. */
  generativeSecondsPerFinishedMinute: number;
  generativeSecondsCap: number;
  /** Maximum number of hero shots per project (a shot can never self-promote). */
  heroQuota: number;
  /** Paid attempts per shot for motion (1 = no identical retry). */
  maxMotionAttempts: number;
  maxStillAttempts: number;
  allowedQualityTiers: QualityTier[];
  /** Shot classes for which economy generative video is forbidden (R01 exceptions must be explicit here). */
  economyForbiddenClasses: ShotClass[];
  /** Every picture must move at least with the camera (no frozen stills on screen). */
  minimumOnScreenMotion: "none" | "camera";
  /** Default priors: informative only in V1. */
  priors: { expectedSemanticPassRate: number };
  /**
   * V1.1 timeline rhythm (PROVISIONAL BUSINESS CONSTRAINTS, chosen before any DULCE/Ocean
   * run and not calibrated): a run of consecutive flat stills may not exceed these limits.
   */
  rhythm?: { maxConsecutiveStillSeconds: number; maxConsecutiveStillShots: number; motionDensityWindowSeconds: number };
};

const ALL: Method[] = ["EXISTING_APPROVED_ASSET", "STOCK", "AI_STILL", "STILL_KEN_BURNS", "STILL_PARALLAX", "I2V_ECONOMY", "I2V_HERO"];

export const PROFILES: Record<ProductionProfile["id"], ProductionProfile> = {
  LONGFORM_16X9: {
    id: "LONGFORM_16X9",
    profileVersion: "longform-16x9/1",
    aspect: "16:9",
    allowedMethods: ALL,
    forbiddenMethods: [],
    // DULCE Part I shipped 70.9 s of new generative video over 9.7 min (7.3 s/min); 44 clips would have been 38.9 s/min.
    generativeSecondsPerFinishedMinute: 8,
    generativeSecondsCap: 120,
    heroQuota: 1,
    maxMotionAttempts: 1,
    maxStillAttempts: 2,
    allowedQualityTiers: ["economy", "standard", "hero"],
    economyForbiddenClasses: ["multi_human"],
    minimumOnScreenMotion: "camera",
    priors: { expectedSemanticPassRate: 0.8 },
  },
  SHORT_9X16: {
    id: "SHORT_9X16",
    profileVersion: "short-9x16/1",
    aspect: "9:16",
    allowedMethods: ALL,
    forbiddenMethods: ["STILL_PARALLAX"],
    // Shorts are motion-dense by nature: a larger share per minute, but a small absolute cap.
    generativeSecondsPerFinishedMinute: 20,
    generativeSecondsCap: 30,
    heroQuota: 1,
    maxMotionAttempts: 1,
    maxStillAttempts: 2,
    allowedQualityTiers: ["economy", "standard", "hero"],
    economyForbiddenClasses: ["multi_human"],
    minimumOnScreenMotion: "camera",
    priors: { expectedSemanticPassRate: 0.8 },
  },
  AVATAR: {
    id: "AVATAR",
    profileVersion: "avatar/1",
    aspect: "16:9",
    // The avatar provider supplies the motion; generative b-roll is out of scope for this profile.
    allowedMethods: ["EXISTING_APPROVED_ASSET", "STOCK", "AI_STILL", "STILL_KEN_BURNS"],
    forbiddenMethods: ["STILL_PARALLAX", "I2V_ECONOMY", "I2V_HERO"],
    generativeSecondsPerFinishedMinute: 0,
    generativeSecondsCap: 0,
    heroQuota: 0,
    maxMotionAttempts: 0,
    maxStillAttempts: 2,
    allowedQualityTiers: ["economy", "standard"],
    economyForbiddenClasses: ["multi_human", "human_creature"],
    minimumOnScreenMotion: "camera",
    priors: { expectedSemanticPassRate: 0.8 },
  },
};

/** V1.1 profiles: identical to V1 (same 8 s/min ceiling, hero quota, attempts) plus rhythm limits. */
export const PROFILES_V1_1: Record<ProductionProfile["id"], ProductionProfile> = {
  LONGFORM_16X9: { ...PROFILES.LONGFORM_16X9, profileVersion: "longform-16x9/1.1", rhythm: { maxConsecutiveStillSeconds: 30, maxConsecutiveStillShots: 6, motionDensityWindowSeconds: 60 } },
  SHORT_9X16: { ...PROFILES.SHORT_9X16, profileVersion: "short-9x16/1.1", rhythm: { maxConsecutiveStillSeconds: 8, maxConsecutiveStillShots: 3, motionDensityWindowSeconds: 15 } },
  AVATAR: { ...PROFILES.AVATAR, profileVersion: "avatar/1.1" }, // the avatar supplies motion: no rhythm rule
};

export function methodAllowed(p: ProductionProfile, m: Method): boolean {
  return p.allowedMethods.includes(m) && !p.forbiddenMethods.includes(m);
}

export function generativeSecondsBudget(p: ProductionProfile, finishedSeconds: number): number {
  return Math.min(p.generativeSecondsCap, Math.floor((p.generativeSecondsPerFinishedMinute * finishedSeconds) / 60));
}
