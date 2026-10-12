/**
 * Cinematic Director V1 — versioned contracts (Zod). PROPOSAL ONLY: a plan built from these contracts never
 * executes anything by itself (`executable: false`, `paidCalls: 0` are part of the schema), never calls an LLM
 * and never generates media. It sits in front of the existing pipeline (production-plan.ts, shot-executor.ts,
 * cinematic-director.ts, the Python editor manifest) and does not replace any of their contracts.
 * Design and inventory: docs/cinematic-director/ARCHITECTURE.md.
 */
import { z } from "zod";

export const DIRECTOR_INPUT_VERSION = "director-input@1";
export const DIRECTOR_PLAN_VERSION = "director-plan@1";
export const RECIPE_CATALOG_SCHEMA = "atomivid/cinematic-recipes@1";

export const GENRES = ["misterio", "documental", "reel"] as const;
export const MOVEMENTS = ["static", "real_motion", "push_in_still", "handheld", "pan"] as const;
export const EVIDENCE_POLICIES = ["authentic_only", "recreation_ok", "either"] as const;
/** Same vocabulary as remotion/long-form-card-fit.ts SceneProvenance. */
export const PROVENANCES = ["archival_documentary", "stock_illustrative", "ai_recreation", "data_graphic"] as const;
export const LABELS = ["recreacion_ia", "ilustrativa"] as const;

export const RecipeSchema = z.object({
  id: z.string().regex(/^[a-z]+(-[a-z0-9]+)+$/),
  version: z.number().int().positive(),
  genre: z.enum(GENRES),
  name: z.string().min(3),
  use_when: z.array(z.string().min(3)).min(1),
  avoid_when: z.array(z.string().min(3)).min(1),
  duration_s: z.object({ min: z.number().positive(), typical: z.number().positive(), max: z.number().positive() })
    .refine(d => d.min <= d.typical && d.typical <= d.max, "min <= typical <= max"),
  intent: z.string().min(5),
  shot: z.object({ type: z.string().min(3), pov: z.string().optional() }),
  lens: z.string().optional(),
  composition: z.string().min(5),
  movement: z.object({ kind: z.enum(MOVEMENTS), note: z.string() }),
  lighting: z.string().min(3),
  continuity: z.string().min(3),
  transitions: z.object({ in: z.array(z.string()).min(1), out: z.array(z.string()).min(1) }),
  sfx: z.string(),
  placeholders: z.array(z.string().regex(/^\{[a-z_]+\}$/)),
  negatives: z.array(z.string().min(3)).min(1),
  evidence_policy: z.enum(EVIDENCE_POLICIES),
  label: z.enum(LABELS).nullable(),
  example: z.string().min(10),
}).strict()
  // A recipe that may only show authentic evidence can never carry the AI-recreation label.
  .refine(r => !(r.evidence_policy === "authentic_only" && r.label === "recreacion_ia"), "authentic_only recipes cannot be labelled recreacion_ia")
  // No universal "8K anamorphic" look: it may appear only as a negative, never as a positive instruction.
  .refine(r => ![r.composition, r.lighting, r.lens ?? "", r.example].some(t => /8k|anamorphic/i.test(t)), "no universal 8K/anamorphic suffix");
export type Recipe = z.infer<typeof RecipeSchema>;

export const RecipeCatalogSchema = z.object({
  schema: z.literal(RECIPE_CATALOG_SCHEMA),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  generated_by: z.string(),
  notes: z.string(),
  recipes: z.array(RecipeSchema).min(1),
}).refine(c => new Set(c.recipes.map(r => r.id)).size === c.recipes.length, "recipe ids must be unique");
export type RecipeCatalog = z.infer<typeof RecipeCatalogSchema>;

export const InventoryAssetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["video", "image", "graphic", "avatar"]),
  provenance: z.enum(PROVENANCES),
  motion: z.enum(["real", "still"]),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  dhash: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  license: z.enum(["CLEARED", "NEEDS_REVIEW", "NOT_CLEARED"]).default("NEEDS_REVIEW"),
  tags: z.array(z.string()).default([]),
});
export type InventoryAsset = z.infer<typeof InventoryAssetSchema>;

export const SegmentSchema = z.object({
  id: z.string().min(1),
  start: z.number().min(0),
  end: z.number().positive(),
  text: z.string(),
  beat: z.string().optional(),
  /** Authentic evidence available for this segment (an inventory asset id). */
  evidenceAssetId: z.string().optional(),
  /** A locked segment (approved avatar, signed lip-sync) is passed through untouched. */
  locked: z.object({ reason: z.enum(["avatar", "approved"]), assetId: z.string() }).optional(),
}).refine(s => s.end > s.start, "segment end must be > start");

export const DirectorInputSchema = z.object({
  version: z.literal(DIRECTOR_INPUT_VERSION),
  genre: z.enum(GENRES),
  aspect: z.enum(["16:9", "9:16"]),
  totalSeconds: z.number().positive(),
  segments: z.array(SegmentSchema).min(1),
  inventory: z.array(InventoryAssetSchema),
  constraints: z.object({
    minShotSeconds: z.number().positive().default(3),
    maxShotSeconds: z.number().positive().default(8),
    maxTitleSeconds: z.number().positive().default(3),
    subtitleLines: z.number().int().positive().default(2),
  }).default({ minShotSeconds: 3, maxShotSeconds: 8, maxTitleSeconds: 3, subtitleLines: 2 }),
  budget: z.object({
    remainingUsd: z.number().min(0),
    unitCostsUsd: z.object({ ai_image: z.number().min(0), ai_video: z.number().min(0) }),
    /** AI video is the expensive path: off unless explicitly allowed (then still subject to production caps). */
    allowAiVideo: z.boolean().default(false),
  }),
  continuity: z.object({ era: z.string().optional(), wardrobe: z.string().optional() }).default({}),
});
export type DirectorInput = z.infer<typeof DirectorInputSchema>;
export type DirectorInputRaw = z.input<typeof DirectorInputSchema>;

export const PlannedShotSchema = z.object({
  id: z.string(),
  segmentId: z.string(),
  start: z.number().min(0),
  end: z.number().positive(),
  /** Exact substring of the segment text this shot illustrates (empty only for locked segments). */
  anchorText: z.string(),
  recipeId: z.string().nullable(),
  recipeVersion: z.number().int().positive().nullable(),
  intent: z.string(),
  shotType: z.string(),
  movement: z.object({ kind: z.enum(MOVEMENTS), realMotion: z.boolean() }),
  asset: z.object({
    status: z.enum(["chosen", "needs_new", "locked", "none"]),
    assetId: z.string().optional(),
    provenance: z.enum(PROVENANCES).optional(),
    alternatives: z.array(z.string()),
    label: z.enum(LABELS).nullable(),
  }),
  /** Why new material would be needed; never executed by the plan. */
  newMaterial: z.object({ reason: z.string(), kind: z.enum(["ai_image", "ai_video"]), estimatedMaxUsd: z.number().min(0) }).optional(),
  uncertainty: z.array(z.string()),
});
export type PlannedShot = z.infer<typeof PlannedShotSchema>;

export const DirectorPlanSchema = z.object({
  version: z.literal(DIRECTOR_PLAN_VERSION),
  mode: z.literal("proposal"),
  executable: z.literal(false),
  paidCalls: z.literal(0),
  genre: z.enum(GENRES),
  catalogVersion: z.string(),
  totalSeconds: z.number().positive(),
  shots: z.array(PlannedShotSchema).min(1),
  estimatedMaxUsd: z.number().min(0),
  qualityNote: z.literal("semántica y calidad visual: estimado/no validado sin anotación humana"),
});
export type DirectorPlan = z.infer<typeof DirectorPlanSchema>;
