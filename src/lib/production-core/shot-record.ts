/**
 * Production Shot Record: the explicit, auditable contract of ONE shot across its whole
 * life (plan -> assets -> QA -> master). It is ADDITIVE over what already exists:
 * - the PI Shot Contract (production-intelligence/contract.ts) is embedded, not duplicated;
 * - Long Form `Shot` fields (video/long-form/types.ts) and durable-asset provenance
 *   (video/long-form/durable-shot-assets.ts) are reused by type;
 * - lifecycle states come from production-intelligence/state-machine.ts.
 * Nothing here spends or calls a provider.
 */
import { z } from "zod";
import { ShotContractSchema, type ShotContract, type ShotContractInput } from "../production-intelligence/contract";
import { ASSET_STATES } from "../production-intelligence/state-machine";
import { METHODS } from "../production-intelligence/ladder";
import { SHOT_TYPES, HISTORICAL_CLASSIFICATIONS, type Shot as LongFormShot } from "../video/long-form/types";
import type { AssetProvenance } from "../video/long-form/durable-shot-assets";

export const SHOT_RECORD_VERSION = "shot-record/1";

export const CAMERA_BEHAVIORS = ["static", "ken_burns", "pan", "cut", "parallax", "generated"] as const;
export const TRANSITIONS = ["cut", "dissolve", "dip_to_black", "match_cut"] as const;
export const SUBTITLE_INTERACTIONS = ["normal", "avoid_lower_third", "no_subtitles", "title_card_exclusive"] as const;
export const QA_STATUSES = ["NOT_RUN", "PENDING", "PASS", "PASS_WITH_NOTE", "TRIM", "FALLBACK", "FAIL"] as const;
export const FALLBACK_STATES = ["NONE", "STILL_MOTION_FALLBACK", "STOCK_FALLBACK", "TEXT_CARD_FALLBACK", "HUMAN_REVIEW"] as const;
export const SOURCE_PROVIDERS = ["openai", "runway", "veo", "pexels", "elevenlabs", "internal", "existing", "manual"] as const;

const Provenance = z.object({ kind: z.enum(["archival_documentary", "stock_illustrative", "ai_recreation"]), provider: z.string(), license: z.string().optional(), author: z.string().optional(), pageUrl: z.string().optional() });

export const ProductionShotRecordSchema = z.object({
  recordVersion: z.literal(SHOT_RECORD_VERSION).default(SHOT_RECORD_VERSION),
  /** The PI contract is the engine-facing part; everything else is production bookkeeping. */
  contract: ShotContractSchema,
  sceneId: z.string().min(1),
  blockId: z.string().min(1),
  timelineOrder: z.number().int().nonnegative(),
  narrativePurpose: z.string().min(1),
  assetType: z.enum(SHOT_TYPES),
  sourceProvider: z.enum(SOURCE_PROVIDERS),
  durationTargetSec: z.number().positive(),
  minVisibleSec: z.number().positive(),
  cameraBehavior: z.enum(CAMERA_BEHAVIORS),
  transitionIn: z.enum(TRANSITIONS),
  characterReferences: z.array(z.object({ character: z.string().min(1), referenceAssetId: z.string().nullable() })).default([]),
  continuityConstraints: z.array(z.string()).default([]),
  historicalClassification: z.enum(HISTORICAL_CLASSIFICATIONS).nullable().default(null),
  subtitleInteraction: z.enum(SUBTITLE_INTERACTIONS).default("normal"),
  provenance: Provenance.nullable().default(null),
  // ---- cost (all in USD; a provider top-up is NEVER written here) ----
  expectedCostUsd: z.number().nonnegative().default(0),
  reservedCostUsd: z.number().nonnegative().default(0),
  actualCostUsd: z.number().nonnegative().nullable().default(null),
  // ---- lifecycle ----
  plannedMethod: z.enum(METHODS).nullable().default(null),
  lifecycleState: z.enum(ASSET_STATES).default("PLANNED"),
  qaStatus: z.enum(QA_STATUSES).default("NOT_RUN"),
  retryCount: z.number().int().nonnegative().default(0),
  fallbackState: z.enum(FALLBACK_STATES).default("NONE"),
  decisionHash: z.string().nullable().default(null),
}).superRefine((r, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: "custom", message: `${r.contract.shotId}: ${message}` });
  if (r.minVisibleSec > r.durationTargetSec) bad("minVisibleSec cannot exceed durationTargetSec");
  if (r.provenance?.kind === "ai_recreation" && r.historicalClassification === "real_documented") bad("an AI recreation can never be classified real_documented");
  if (r.assetType === "ai_video" && r.provenance && r.provenance.kind !== "ai_recreation") bad("ai_video provenance must be ai_recreation");
  if ((r.assetType === "text" || r.assetType === "diagram" || r.assetType === "map") && r.cameraBehavior === "generated") bad("graphics and text cards never use generated motion");
  if (r.actualCostUsd !== null && r.lifecycleState === "PLANNED") bad("a PLANNED shot cannot have an actual cost");
});
export type ProductionShotRecord = z.infer<typeof ProductionShotRecordSchema>;
export type ProductionShotRecordInput = z.input<typeof ProductionShotRecordSchema>;

export function parseShotRecord(input: unknown): ProductionShotRecord {
  return ProductionShotRecordSchema.parse(input);
}

/** Existing Long Form shot type -> PI shot class + asset bookkeeping (no information invented). */
const SHOT_TYPE_TO_CLASS: Record<LongFormShot["type"], ShotContract["shotClass"]> = {
  stock_video: "broll", stock_image: "broll", generated_placeholder: "other", text: "graphic", diagram: "graphic", map: "map", ken_burns_image: "other", ai_video: "other",
};

/**
 * Build a record from an existing Long Form `Shot` plus the production judgments the
 * storyboard step must supply (leverage, risk, class). Reuses the shot's own fields
 * (visualIntent, motion, historicalClassification, dedupKey) instead of re-declaring them.
 */
export function recordFromLongFormShot(shot: LongFormShot, judgments: Pick<ShotContractInput, "motionLeverage" | "riskClass" | "motionRequirement" | "qualityTier"> & { shotClass?: ShotContract["shotClass"]; narrativePurpose: string; minVisibleSec?: number; sourceProvider?: ProductionShotRecord["sourceProvider"]; maxGeneratedDuration?: number }, timelineOrder: number): ProductionShotRecord {
  const camera: ProductionShotRecord["cameraBehavior"] = shot.type === "ai_video" ? "generated" : shot.motion;
  return parseShotRecord({
    contract: {
      shotId: shot.id, shotClass: judgments.shotClass ?? SHOT_TYPE_TO_CLASS[shot.type], narrationIntent: shot.narrationFragment ?? shot.captionText, visualIntent: shot.visualIntent,
      motionRequirement: judgments.motionRequirement, motionLeverage: judgments.motionLeverage, riskClass: judgments.riskClass, qualityTier: judgments.qualityTier,
      desiredDuration: shot.durationSec, maxGeneratedDuration: judgments.maxGeneratedDuration ?? 10, continuityGroup: shot.beatId,
      existingApprovedAssetId: shot.source === "local" && shot.status === "rendered" ? shot.assetId : null,
      stockAvailable: shot.type === "stock_video",
    },
    sceneId: shot.id, blockId: shot.beatId, timelineOrder, narrativePurpose: judgments.narrativePurpose, assetType: shot.type,
    sourceProvider: judgments.sourceProvider ?? (shot.source === "stock" ? "pexels" : shot.source === "generated" ? "openai" : shot.source === "local" ? "existing" : "internal"),
    durationTargetSec: shot.durationSec, minVisibleSec: Math.min(judgments.minVisibleSec ?? 2.5, shot.durationSec), cameraBehavior: camera, transitionIn: "cut",
    historicalClassification: shot.historicalClassification ?? null,
  });
}

/** Provenance from an existing durable asset record (never invented: null when the record has none). */
export function withProvenance(r: ProductionShotRecord, p: AssetProvenance | undefined): ProductionShotRecord {
  return parseShotRecord({ ...r, provenance: p ?? null });
}
