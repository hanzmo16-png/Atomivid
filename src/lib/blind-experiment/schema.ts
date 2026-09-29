/**
 * Blind Project human baseline schema. This is EXPERIMENT data, not Production Intelligence:
 * it holds the human answer (what the producer would do) next to the shot inputs PI may see.
 * Every field is required and UNKNOWN is not a legal value (protocol unknownPolicy.baseline).
 */
import { z } from "zod";
import { METHODS } from "../production-intelligence/ladder";
import { SHOT_CLASSES, MOTION_REQUIREMENTS, MOTION_LEVERAGE, RISK_CLASSES, QUALITY_TIERS } from "../production-intelligence/contract";

export const SOURCE_TYPES = ["STOCK_VIDEO", "STOCK_PHOTO", "AI_STILL", "ARCHIVAL_VIDEO", "ARCHIVAL_PHOTO", "GRAPHIC", "MAP", "EXISTING_APPROVED_ASSET", "OTHER"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
/** Sources that are moving footage. A photo is never motion (Ocean NF1). */
export const MOVING_SOURCES: readonly SourceType[] = ["STOCK_VIDEO", "ARCHIVAL_VIDEO"];

export const MOTION_JUDGMENTS = ["MOTION_ESSENTIAL", "MOTION_BENEFICIAL", "MOTION_UNNECESSARY"] as const;
const Method = z.enum(METHODS);
const I2V = new Set(["I2V_ECONOMY", "I2V_HERO"]);

/** Fields PI V1.1 may receive (protocol piInputAllowlist). */
export const ShotInputSchema = z.object({
  shotId: z.string().min(1),
  timelineOrder: z.number().int().nonnegative(),
  duration: z.number().positive(),
  narrationIntent: z.string().min(1),
  visualIntent: z.string().min(1),
  shotClass: z.enum(SHOT_CLASSES),
  sourceType: z.enum(SOURCE_TYPES),
  characters: z.array(z.string()),
  identityCritical: z.boolean(),
  multiHuman: z.boolean(),
  complexHands: z.boolean(),
  motionRequirement: z.enum(MOTION_REQUIREMENTS),
  motionLeverage: z.enum(MOTION_LEVERAGE),
  riskClass: z.enum(RISK_CLASSES),
  qualityTier: z.enum(QUALITY_TIERS),
  existingAsset: z.string().min(1).nullable(),
  existingAssetApproved: z.boolean(),
  existingAssetKind: z.enum(["clip", "still"]).nullable(),
  continuityGroup: z.string().nullable(),
  previousState: z.string().nullable(),
  nextState: z.string().nullable(),
});

/** The human answer (protocol humanAnswerFields). PI never receives any of these. */
export const HumanAnswerSchema = z.object({
  motionJudgment: z.enum(MOTION_JUDGMENTS),
  humanPreferredMethod: Method,
  humanWouldGenerateVideo: z.boolean(),
  humanReason: z.string().min(1),
  /** Methods the human considers able to carry this shot's narrative claim. */
  adequateMethods: z.array(Method).min(1),
  cheaperMethodSufficient: z.boolean(),
  generationRiskUnacceptable: z.boolean(),
  /** Required exactly when humanPreferredMethod is I2V. */
  i2vPlan: z.object({ why: z.string().min(1), durationSeconds: z.number().positive(), expectedProvider: z.string().min(1), estimatedCostUsd: z.number().nonnegative() }).nullable(),
});

export const HumanShotSchema = ShotInputSchema.extend(HumanAnswerSchema.shape).superRefine((s, ctx) => {
  const gen = I2V.has(s.humanPreferredMethod);
  const bad = (message: string) => ctx.addIssue({ code: "custom", message: `${s.shotId}: ${message}` });
  if (gen !== s.humanWouldGenerateVideo) bad("humanWouldGenerateVideo must match humanPreferredMethod");
  if (gen !== (s.i2vPlan !== null)) bad("i2vPlan is required exactly for I2V methods");
  if (!s.adequateMethods.includes(s.humanPreferredMethod)) bad("humanPreferredMethod must be one of adequateMethods");
  if (s.sourceType === "GRAPHIC" && s.shotClass !== "graphic") bad("GRAPHIC source requires shotClass graphic");
  if (s.sourceType === "MAP" && s.shotClass !== "map") bad("MAP source requires shotClass map");
  if (s.sourceType === "EXISTING_APPROVED_ASSET" && !(s.existingAsset && s.existingAssetApproved)) bad("EXISTING_APPROVED_ASSET source requires an approved existingAsset");
  if (s.existingAsset && !s.existingAssetKind) bad("existingAssetKind is required with existingAsset");
  if (s.multiHuman && s.shotClass === "single_human") bad("multiHuman contradicts shotClass single_human");
  if (s.humanPreferredMethod === "EXISTING_APPROVED_ASSET" && !(s.existingAsset && s.existingAssetApproved)) bad("EXISTING_APPROVED_ASSET needs an approved existingAsset");
});
export type HumanShot = z.infer<typeof HumanShotSchema>;

const Doc = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) });

export const HumanBaselineSchema = z.object({
  projectId: z.string().min(1),
  protocolVersion: z.string().min(1),
  episodeTopic: z.string().min(1),
  finishedSeconds: z.number().positive(),
  productionBudgetUsd: z.number().positive(),
  /** Hashes of the editorial inputs (research, script, storyboard) at seal time. */
  documents: z.object({ research: Doc, script: Doc, storyboard: Doc }),
  shots: z.array(HumanShotSchema).min(1),
}).superRefine((b, ctx) => {
  if (b.episodeTopic === "PENDING") ctx.addIssue({ code: "custom", message: "episodeTopic is PENDING: a baseline needs a user-selected topic" });
  const ids = b.shots.map((s) => s.shotId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "duplicate shotId" });
  const orders = b.shots.map((s) => s.timelineOrder);
  if (new Set(orders).size !== orders.length) ctx.addIssue({ code: "custom", message: "duplicate timelineOrder" });
  if (JSON.stringify(b).includes("\"UNKNOWN\"")) ctx.addIssue({ code: "custom", message: "UNKNOWN is not allowed in a human baseline" });
});
export type HumanBaseline = z.infer<typeof HumanBaselineSchema>;
export type HumanBaselineInput = z.input<typeof HumanBaselineSchema>;

export const ANSWER_FIELDS = Object.keys(HumanAnswerSchema.shape) as (keyof z.infer<typeof HumanAnswerSchema>)[];
export const INPUT_FIELDS = Object.keys(ShotInputSchema.shape) as (keyof z.infer<typeof ShotInputSchema>)[];
