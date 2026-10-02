/**
 * VFX / TRANSFORM SCENE (VFX Provider V1): a REAL source video + a described transformation →
 * a transformed video that re-enters the normal edit/master pipeline.
 *
 * A capability of its own, not ai_video: ai_video generates new footage from a prompt or a
 * reference image (VideoProvider in ../types.ts); VFX transforms footage that already exists
 * and must keep its subject, motion and timing. Results carry `kind: "vfx_transform"` and live
 * under "vfx:" ledger shots, so the two can never be mistaken for each other.
 *
 * Providers (Luma first; Runway/Kling/Veo later) plug in behind `VfxProvider`; the pipeline only
 * talks to the paid-call wrapper in src/lib/paid-calls/gated-vfx.ts.
 */
import type { GenerativeCapabilities } from "../types";

/** How far the provider may move away from the source (product-level, provider-agnostic). */
export type VfxStrength = "subtle" | "balanced" | "strong";
/** Output quality tier; each provider maps it to a concrete model. */
export type VfxQuality = "draft" | "standard" | "high";
export type VfxAspectRatio = "9:16" | "16:9" | "1:1";

/** The exact source footage. `sha256` is of the bytes actually sent (after any local trim). */
export type VfxSource = {
  /** HTTPS URL the provider can fetch (e.g. a short-lived signed URL). Never part of the identity. */
  url: string;
  sha256: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
};

export type VfxTransformRequest = {
  source: VfxSource;
  /** Range of the source the transformation covers (trimmed locally before upload). */
  range: { startSeconds: number; endSeconds: number };
  prompt: string;
  negativePrompt?: string;
  aspectRatio: VfxAspectRatio;
  /** Keep the person (identity, body, clothes, motion); transform mainly the environment. */
  preserveSubject: boolean;
  strength: VfxStrength;
  /** Free cinematic style hint (e.g. "cinematic New York at night"); part of the identity. */
  style?: string;
  quality: VfxQuality;
  seed?: string;
  /** Budget for THIS operation; the provider must refuse before submitting if it would exceed it. */
  maxCostUsd: number;
  /** Called as soon as the provider accepted the paid job (has an id), before polling. */
  onProviderJobAccepted?: (providerJobId: string) => Promise<void> | void;
};

/** Normalized transformed clip. `kind` is what separates it from any ai_video asset. */
export type VfxAsset = {
  kind: "vfx_transform";
  buffer: Buffer;
  mimeType: string;
  extension: string;
  model: string;
  costUsd: number;
  costBasis: "provider_usage" | "estimated";
  providerJobId?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
};

export type VfxCapabilities = GenerativeCapabilities & {
  /**
   * true only once the endpoint, payload and auth were checked against the provider's primary
   * documentation and a human confirmed them. While false, nothing may submit a paid request:
   * gated-vfx refuses before writing a ledger row.
   */
  contractVerified: boolean;
  /** Longest source range (seconds) per model, when known. */
  maxRangeSeconds: Record<string, number>;
};

export interface VfxProvider {
  readonly name: string;
  readonly capabilities: VfxCapabilities;
  isAvailable(): boolean;
  /** Concrete model this request runs on (part of the paid-call identity). */
  resolveModel(request: VfxTransformRequest): string;
  /** Pre-call estimate from VERIFIED prices only; throws when the price is not verified. */
  estimateCostUsd(request: VfxTransformRequest): number;
  transformVideo(request: VfxTransformRequest): Promise<VfxAsset>;
  /** Resume an already accepted (billable) job without resubmitting. */
  resumeTransform?(providerJobId: string, request: VfxTransformRequest): Promise<VfxAsset>;
}

/**
 * Product contract for a future "VFX / Transform Scene" UI: what a user may set. Only design; no
 * UI, no new credit system. `toVfxTransformRequest` turns it into the provider-agnostic request.
 */
export type TransformSceneInput = {
  /** "Describe la transformación." */
  prompt: string;
  preserveSubject?: boolean;
  strength?: VfxStrength;
  cinematicStyle?: string;
  outputQuality?: VfxQuality;
};

export const TRANSFORM_SCENE_DEFAULTS = { preserveSubject: true, strength: "balanced", outputQuality: "standard" } as const;
export const TRANSFORM_SCENE_PROMPT_MAX = 1000;

export function toVfxTransformRequest(
  input: TransformSceneInput,
  source: VfxSource,
  opts: { range?: { startSeconds: number; endSeconds: number }; aspectRatio: VfxAspectRatio; maxCostUsd: number; negativePrompt?: string; seed?: string },
): VfxTransformRequest {
  const prompt = input.prompt.trim();
  if (!prompt || [...prompt].length > TRANSFORM_SCENE_PROMPT_MAX) throw new Error(`La transformación debe tener entre 1 y ${TRANSFORM_SCENE_PROMPT_MAX} caracteres.`);
  const range = opts.range ?? { startSeconds: 0, endSeconds: source.durationSeconds };
  if (!(range.startSeconds >= 0 && range.endSeconds > range.startSeconds && range.endSeconds <= source.durationSeconds + 1e-6)) throw new Error("Rango de video fuera del clip de origen.");
  return {
    source,
    range,
    prompt,
    negativePrompt: opts.negativePrompt,
    aspectRatio: opts.aspectRatio,
    preserveSubject: input.preserveSubject ?? TRANSFORM_SCENE_DEFAULTS.preserveSubject,
    strength: input.strength ?? TRANSFORM_SCENE_DEFAULTS.strength,
    style: input.cinematicStyle?.trim() || undefined,
    quality: input.outputQuality ?? TRANSFORM_SCENE_DEFAULTS.outputQuality,
    seed: opts.seed,
    maxCostUsd: opts.maxCostUsd,
  };
}

export const vfxRangeSeconds = (r: VfxTransformRequest) => Math.max(0, r.range.endSeconds - r.range.startSeconds);
