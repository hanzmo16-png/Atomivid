/**
 * Cinematic Director V1 — versioned contracts (Zod). PROPOSAL ONLY: a plan built from these contracts never
 * executes anything by itself (`executable: false`, `paidCalls: 0` are part of the schema), never calls an LLM
 * and never generates media. It sits in front of the existing pipeline (production-plan.ts, shot-executor.ts,
 * cinematic-director.ts, the Python editor manifest) and does not replace any of their contracts.
 * Design and inventory: docs/cinematic-director/ARCHITECTURE.md.
 */
import { z } from "zod";

export const DIRECTOR_INPUT_VERSION = "director-input@2";
export const DIRECTOR_PLAN_VERSION = "director-plan@2";
export const RECIPE_CATALOG_SCHEMA = "atomivid/cinematic-recipes@2";
/** Versioned documentary policy (visual bible v1 made operable); see policy.ts. */
export const DOCUMENTARY_POLICY_VERSION = "documentary-policy@1";

export const GENRES = ["misterio", "documental", "reel"] as const;
/** graphic_animation = a deterministic graphic built up in stages (never presented as filmed motion). */
export const MOVEMENTS = ["static", "real_motion", "push_in_still", "handheld", "pan", "graphic_animation"] as const;
export const EVIDENCE_POLICIES = ["authentic_only", "recreation_ok", "either"] as const;
/** Same vocabulary as remotion/long-form-card-fit.ts SceneProvenance. */
export const PROVENANCES = ["archival_documentary", "stock_illustrative", "ai_recreation", "data_graphic"] as const;
export const LABELS = ["recreacion_ia", "ilustrativa"] as const;
/** What an asset shows, as a coarse visual type (derived from storyboard metadata; never from pixels). */
export const VISUAL_TYPES = ["landscape", "structure", "relief", "artifact", "people", "hands_work", "excavation", "remains", "map", "timeline", "diagram", "text", "concept"] as const;
/** Policy classes per narrative unit, most restrictive first. */
export const POLICY_CLASSES = ["human_remains", "specific_evidence", "measurable_data", "hypothesis", "atmosphere"] as const;
/** Storyboard asset classification (visual bible §2). */
export const BIBLE_CLASSES = ["REAL_DOCUMENTARY", "STOCK_REAL", "DETERMINISTIC", "AI_RECREATION", "TEXT"] as const;

/**
 * Operable selection rule of a recipe. A recipe is only proposed automatically when its rule matches: the asset's
 * visual type must be accepted, and when topics/keywords are listed the narrative unit must hit at least one.
 * Rotation only breaks ties between compatible recipes. `still` says what to do when the recipe asks for real
 * motion but the asset is a still: hold it static, zoom (declared), or leave the movement pending.
 */
export const RecipeSelectSchema = z.object({
  visual: z.array(z.union([z.enum(VISUAL_TYPES), z.literal("*")])).min(1),
  topics_any: z.array(z.string()).default([]),
  keywords_any: z.array(z.string()).default([]),
  topics_none: z.array(z.string()).default([]),
  still: z.enum(["static", "push_in_still", "pending"]).default("static"),
  position: z.enum(["any", "first", "last"]).default("any"),
  /** Provenances this recipe may dress (empty = any allowed by evidence_policy). A reconstruction never dresses a real photo. */
  provenance: z.array(z.enum(PROVENANCES)).default([]),
  /** Neutral atmosphere: allowed next to sensitive narration only because it explicitly does not depict the finding. */
  neutral: z.boolean().default(false),
  /** Recipe set: "fiction" recipes are offered ONLY to an input that declares style "fiction" (and only they are). */
  style: z.enum(["fiction"]).optional(),
  /** "approved_presenter": the recipe promises a presenter/avatar on screen, so it may only dress an APPROVED presenter or avatar asset. */
  requires: z.enum(["approved_presenter"]).optional(),
}).strict();
export type RecipeSelect = z.infer<typeof RecipeSelectSchema>;

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
  /** The recipe's sound design is the clip's own sound (e.g. generated ambience/impacts). Applied only when the render opts in. */
  clip_audio: z.boolean().optional(),
  placeholders: z.array(z.string().regex(/^\{[a-z_]+\}$/)),
  negatives: z.array(z.string().min(3)).min(1),
  evidence_policy: z.enum(EVIDENCE_POLICIES),
  label: z.enum(LABELS).nullable(),
  example: z.string().min(10),
  select: RecipeSelectSchema,
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
  kind: z.enum(["video", "image", "graphic", "avatar", "text"]),
  provenance: z.enum(PROVENANCES),
  motion: z.enum(["real", "still"]),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  dhash: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  license: z.enum(["CLEARED", "NEEDS_REVIEW", "NOT_CLEARED"]).default("NEEDS_REVIEW"),
  tags: z.array(z.string()).default([]),
  /** Editorial metadata (from an approved storyboard when available). Absent = unknown, never assumed safe. */
  content: z.object({
    visualType: z.enum(VISUAL_TYPES).optional(),
    topics: z.array(z.string()).default([]),
    visualIntent: z.string().optional(),
    description: z.string().optional(),
    sensitivity: z.enum(["high", "medium", "low"]).optional(),
    bibleClass: z.enum(BIBLE_CLASSES).optional(),
    bibleReason: z.string().optional(),
    /** Planned window inside its segment, as fractions 0..1 of the segment duration. */
    window: z.object({ segmentId: z.string(), from: z.number().min(0).max(1), to: z.number().min(0).max(1) }).optional(),
  }).optional(),
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
  /** Script claims of this segment with their support level (from the approved script). */
  claims: z.array(z.object({ id: z.string(), text: z.string(), support: z.enum(["sourced", "inference", "unverified"]) })).default([]),
  /** Existing word timestamps (one per whitespace token of `text`). Never generated here. */
  wordTimes: z.array(z.object({ start: z.number().min(0), end: z.number().min(0) })).optional(),
  /**
   * T44 F3 (traceability): a data-card window — how ITS OWN two boundaries were obtained (`boundaries`, as returned
   * by cardWindows) and whether the voice's clock attributes the window to one claim (`attribution`). It is carried,
   * never inferred: it does not create per-word times and says nothing about any cut inside the window.
   */
  cardTiming: z.object({
    boundaries: z.enum(["estimated_proportional", "word_timestamps"]),
    attribution: z.enum(["single_claim", "ambiguous_clock", "short_window"]),
  }).optional(),
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
  /** Declared AI fiction (no factual claims): the Director plans with the fiction recipe set. Absent = historic sets. */
  style: z.enum(["fiction"]).optional(),
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
    /** Same deterministic graphic held across consecutive shots of one segment (built up in stages). */
    continuation: z.boolean().optional(),
  }),
  /** Why new material would be needed; never executed by the plan. */
  newMaterial: z.object({ reason: z.string(), kind: z.enum(["ai_image", "ai_video"]), estimatedMaxUsd: z.number().min(0) }).optional(),
  uncertainty: z.array(z.string()),
  // ---- Correction 2: the module emits its own, auditable decision record (nothing is reconstructed afterwards).
  /** How the anchor was cut and how its time was obtained. */
  unit: z.object({
    boundary: z.enum(["sentence", "clause", "word"]),
    timing: z.enum(["estimated_proportional", "word_timestamps"]),
    cutReason: z.string(),
    /** T44 F3: data-card windows only — whether the clock attributes this window to one claim (see Segment.cardTiming).
     *  `ambiguous_clock` stays ambiguous even when its boundaries are measured. */
    attribution: z.enum(["single_claim", "ambiguous_clock", "short_window"]).optional(),
  }),
  /** Documentary policy of the narrative unit (recomputed by the gate, never trusted). */
  policy: z.object({
    version: z.string(),
    class: z.enum(POLICY_CLASSES),
    sources: z.array(z.enum(["storyboard", "script_claims", "lexicon", "default"])),
    signals: z.array(z.string()),
    status: z.enum(["ok", "review_required"]),
    unconfirmed: z.boolean(),
  }),
  /** What the shot shows, in words (asset intent or declared neutral theme). Not a generation prompt. */
  visualTheme: z.string(),
  decision: z.object({
    status: z.enum(["proposed", "weak", "pending"]),
    unitTopics: z.array(z.string()),
    assetBasis: z.array(z.string()),
    recipeBasis: z.array(z.string()),
    sources: z.array(z.enum(["storyboard", "script_claims", "lexicon", "catalog_rule", "rotation", "catalog_order"])),
    pendingReason: z.string().optional(),
    neutral: z.boolean().default(false),
  }),
  /** Catalog suggestions compatible with the recipe; to be reviewed, never executed. */
  suggestions: z.object({
    transitionIn: z.string().nullable(), transitionOut: z.string().nullable(), composition: z.string().nullable(), sound: z.string().nullable(),
    status: z.literal("sugerencia_revisable"),
  }),
}).refine(s => s.end > s.start, "shot end must be > start");
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
