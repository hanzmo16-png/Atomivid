/**
 * Long Form types. Independent of Shorts scene-beats and Avatar.
 * Visual unit is shots[] (3–8s). A beat must not collapse to one image.
 */

export const LONG_FORM_MODES = ["curiosity_documentary", "behavior_essay"] as const;
export type LongFormMode = (typeof LONG_FORM_MODES)[number];

export const BEAT_TYPES = [
  "hook",
  "setup",
  "discovery",
  "escalation",
  "twist",
  "insight",
  "payoff",
  "next_curiosity",
] as const;
export type BeatType = (typeof BEAT_TYPES)[number];

export const SHOT_TYPES = [
  "stock_video",
  "stock_image",
  "generated_placeholder",
  "text",
  "diagram",
  "map",
  "ken_burns_image",
] as const;
export type ShotType = (typeof SHOT_TYPES)[number];

export type ShotMotion = "static" | "ken_burns" | "pan" | "cut";

/**
 * Escalera de calidad/costo para resolver el asset visual de un shot —
 * ver AI Video Pipeline P1 (video/long-form/ai-video-*.ts). El sistema
 * debe poder elegir CUALQUIER punto de esta escalera según disponibilidad,
 * intención narrativa, calidad y costo — video IA nunca es el default,
 * solo una herramienta adicional cuando el movimiento aporta valor
 * narrativo suficiente para justificar su costo (ver ai-video-eligibility.ts).
 */
export const VISUAL_ASSET_TIERS = ["real_video", "real_image", "ai_image", "ai_image_motion", "ai_video"] as const;
export type VisualAssetTier = (typeof VISUAL_ASSET_TIERS)[number];

export type Shot = {
  id: string;
  beatId: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  type: ShotType;
  source: "fixture" | "stock" | "generated" | "local";
  assetId: string;
  localPath?: string;
  visualIntent: string;
  motion: ShotMotion;
  overlay?: string;
  captionText: string;
  license: string;
  attribution: string;
  dedupKey: string;
  status: "planned" | "rendered" | "failed";
  validationStatus: "pending" | "ok" | "fail";

  // --- Campos ADITIVOS del AI Video Pipeline / Visual Director (P1) ---
  // Todos opcionales: ningún storyboard/shot existente (incluido el de
  // VIDEO #001 ya producido) los trae, y ningún código existente los lee
  // todavía — su ausencia nunca cambia el comportamiento actual.
  /** Si el movimiento aporta valor narrativo suficiente para justificar un tratamiento de video/motion (ver ai-video-eligibility.ts). Ausente = sin evaluar todavía. */
  motionRequired?: boolean;
  /** Descripción en inglés del movimiento/cámara deseado, si aplica — insumo del prompt builder, nunca del proveedor de stock/imagen estática. */
  motionDescription?: string;
  /** Preferencia explícita de preproducción (anula al eligibility engine si está presente). */
  preferredAssetType?: VisualAssetTier;
  /** Orden de fallback si `preferredAssetType` no está disponible o excede presupuesto — nunca vacío si está presente. */
  fallbackAssetTypes?: VisualAssetTier[];
  /** Referencia a un asset ya existente (p. ej. una imagen AI_RECREATION aprobada) para animación image-to-video — ver VideoGenerationRequest.referenceImageUrl. */
  referenceAsset?: string;
  /** Estimación de costo (USD) del tratamiento visual de este shot, calculada por el eligibility engine — informativa hasta que algo la consuma. */
  estimatedVisualCostUsd?: number;
  /** Tope explícito de costo (USD) para ESTE shot en particular — si está ausente, el cost guard usa su configuración global. */
  maxVisualCostUsd?: number;
  /** 1 = máxima prioridad (p. ej. el shot de apertura), mayor = menor prioridad — desempate cuando el cost guard no puede conceder todos los shots elegibles dentro del presupuesto. */
  generationPriority?: number;

  // --- Campos RESERVADOS para la futura capa musical (no implementada
  // todavía, ver sección 5 del encargo P1) — ningún código los lee o
  // escribe en este checkpoint; solo evitan que el schema necesite un
  // cambio disruptivo cuando esa fase empiece. ---
  musicTrackId?: string;
  musicIntensity?: number;
  duckingDb?: number;
  ambienceType?: string;
  sfxEvents?: string[];
};

export type LongFormClaim = {
  id: string;
  text: string;
  support: "sourced" | "inference" | "unverified";
  sourceIds: string[];
};

export type LongFormSource = {
  id: string;
  title: string;
  kind: "primary" | "secondary" | "reference";
  locator?: string;
  notes?: string;
};

export type NarrativeBeat = {
  id: string;
  type: BeatType;
  startTargetSec: number;
  endTargetSec: number;
  purpose: string;
  narration: string;
  shots: Shot[];
  claims?: LongFormClaim[];
  sources?: string[];
  emotionalTone?: string;
  patternInterrupt?: boolean;
};

export type SegmentPlan = {
  id: string;
  beatIds: string[];
  shotIds: string[];
  startSec: number;
  endSec: number;
  outputPath?: string;
  status: "pending" | "rendered" | "validated" | "failed";
};

export type LongFormProject = {
  id: string;
  mode: LongFormMode;
  title: string;
  targetDurationSec: number;
  spec: { width: 1920; height: 1080; fps: 30; aspect: "16:9" };
  beats: NarrativeBeat[];
  segments: SegmentPlan[];
};

export const LONG_FORM_SPEC = {
  width: 1920 as const,
  height: 1080 as const,
  fps: 30 as const,
  aspect: "16:9" as const,
};

export const PIPELINE_STAGES = [
  "topic",
  "research",
  "sources",
  "angle",
  "hook",
  "beats",
  "outline",
  "script",
  "claim_check",
  "storyboard",
  "visual_director",
  "tts",
  "music",
  "captions",
  "segment_render",
  "assembly",
  "validation",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export type LongFormBrief = {
  topic: string;
  mode: LongFormMode;
  language: "es" | "en";
  targetDurationSec: number;
};

export type LongFormScript = {
  title: string;
  workingTitleOptions: string[];
  mode: LongFormMode;
  angle: string;
  hook: string;
  beats: NarrativeBeat[];
  sources: LongFormSource[];
  bannedOpenersUsed: boolean;
  slopScore: number;
};

export type LongFormCostEstimate = {
  durationSec: number;
  sceneCount: number;
  assetCount: number;
  llmUsd: number;
  ttsUsd: number;
  imageUsd: number;
  visualUsd: number;
  totalUsd: number;
  usdPerMinute: number;
};
