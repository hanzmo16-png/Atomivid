/**
 * Shot Contract: the normalized, project-agnostic input of Production Intelligence.
 * The engine never reads raw scripts, prompts or project names; only these fields.
 */
import { z } from "zod";

export const CONTRACT_VERSION = "shot-contract/1";

export const SHOT_CLASSES = [
  "landscape", "object", "single_human", "multi_human", "creature", "human_creature",
  "laboratory", "corridor", "graphic", "map", "broll", "talking_head", "other",
] as const;
export type ShotClass = (typeof SHOT_CLASSES)[number];

export const MOTION_REQUIREMENTS = ["none", "camera_only", "simple", "complex"] as const;
export type MotionRequirement = (typeof MOTION_REQUIREMENTS)[number];

export const MOTION_LEVERAGE = ["LOW", "MEDIUM", "HIGH"] as const;
export type MotionLeverage = (typeof MOTION_LEVERAGE)[number];

export const RISK_CLASSES = ["LOW", "MEDIUM", "HIGH"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export const QUALITY_TIERS = ["economy", "standard", "hero"] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

/** Risk markers a contract can carry; each maps to a general rule in decide(). */
export const RISK_FLAGS = [
  "identity_critical", // a recognizable recurring person must stay the same person
  "complex_hands", // hands/body perform a precise action
  "enter_exit_frame", // people enter or leave the frame
] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

export const ShotContractSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION).default(CONTRACT_VERSION),
  shotId: z.string().min(1),
  shotClass: z.enum(SHOT_CLASSES),
  narrationIntent: z.string(),
  visualIntent: z.string(),
  requiredEntities: z.array(z.string()).default([]),
  forbiddenElements: z.array(z.string()).default([]),
  continuityGroup: z.string().nullable().default(null),
  previousState: z.string().nullable().default(null),
  nextState: z.string().nullable().default(null),
  characters: z.array(z.string()).default([]),
  motionRequirement: z.enum(MOTION_REQUIREMENTS),
  motionLeverage: z.enum(MOTION_LEVERAGE),
  riskClass: z.enum(RISK_CLASSES),
  riskFlags: z.array(z.enum(RISK_FLAGS)).default([]),
  desiredDuration: z.number().positive(),
  maxGeneratedDuration: z.number().nonnegative(),
  qualityTier: z.enum(QUALITY_TIERS),
  humanIntervention: z.enum(["none", "human"]).default("none"),
  /** An approved asset that already satisfies the contract (reuse is always cheapest). */
  existingApprovedAssetId: z.string().nullable().default(null),
  /** Stock footage is licensable and acceptable for this contract. */
  stockAvailable: z.boolean().default(false),
});
export type ShotContract = z.infer<typeof ShotContractSchema>;
export type ShotContractInput = z.input<typeof ShotContractSchema>;

export function parseShotContract(input: unknown): ShotContract {
  return ShotContractSchema.parse(input);
}

export function hasFlag(c: ShotContract, f: RiskFlag): boolean {
  return c.riskFlags.includes(f);
}
