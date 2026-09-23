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
