/**
 * VFX / TRANSFORM SCENE (VFX Provider V1): a REAL source video + a described transformation →
 * a transformed video that re-enters the normal edit/master pipeline.
 *
 * A capability of its own, not ai_video: ai_video generates new footage from a prompt or a
 * reference image (VideoProvider in ../types.ts); VFX transforms footage that already exists
 * and must keep its subject, motion and timing. Results carry `kind: "vfx_transform"` and live
 * under "vfx:" ledger shots, so the two can never be mistaken for each other.
 *
 * Providers (Luma Ray 3.2 first; Runway/Kling/others later) plug in behind `VfxProvider`; the
 * pipeline only talks to the paid-call wrapper in src/lib/paid-calls/gated-vfx.ts. Product rule:
 * maximum production quality at the lowest RELIABLE cost — the future metric is cost per approved
 * asset, not cost per generation, so nothing here assumes the cheapest provider wins.
 */
import type { GenerativeCapabilities } from "../types";

/** How far the provider may move away from the source (product-level, provider-agnostic). */
export type VfxStrength = "subtle" | "balanced" | "strong";
export type VfxResolution = "360p" | "540p" | "720p" | "1080p";
export type VfxAspectRatio = "9:16" | "16:9" | "1:1";
/** VFX V1 is SDR only (no HDR, no EXR). */
export type VfxDynamicRange = "sdr";

/**
 * Subject-preservation / conditioning controls (provider-agnostic). Each provider maps them to its
 * own documented controls and ignores none silently: an unsupported control is a request error.
 * `undefined` = provider default.
 */
export type VfxEditControls = {
  /** Keep the face identity (face conditioning). */
  faceIdentity?: boolean;
  /** Keep the body pose/skeleton; "precise" follows it tightly. */
  pose?: "off" | "precise" | "coarse";
  /** Keep scene geometry (depth); freedom 0 = keep exact geometry, 1 = maximum geometric freedom. */
  depth?: { enabled: boolean; freedom?: number };
  /** Keep surface geometry (normals); freedom 0..1 as above. */
  normals?: { enabled: boolean; freedom?: number };
  /** Keep the motion trajectory; sparsity 0..1 (higher = fewer motion anchors). */
  trajectory?: { enabled: boolean; sparsity?: number };
};

/** The exact source footage (the trimmed range actually sent). */
export type VfxSource = {
  /** HTTPS URL the adapter can read the bytes from (e.g. a short-lived signed URL). Never part of the identity. */
  url: string;
  /** sha256 of the exact bytes sent — part of the identity even when the provider uses its own file id. */
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  /** Provider-side durable reference already uploaded for these bytes (e.g. a Luma file_id). Never part of the identity. */
  providerFileId?: string;
};

export type VfxTransformRequest = {
  source: VfxSource;
  /** Range of the original take this source covers (the source is already trimmed to it). */
  range: { startSeconds: number; endSeconds: number };
  prompt: string;
  negativePrompt?: string;
  aspectRatio: VfxAspectRatio;
  resolution: VfxResolution;
  dynamicRange: VfxDynamicRange;
  /** Keep the person (identity, face, body, clothes, motion); transform mainly the environment. */
  preserveSubject: boolean;
  strength: VfxStrength;
  controls?: VfxEditControls;
  /** Free cinematic style hint; part of the identity. */
  style?: string;
  seed?: string;
  /** Budget for THIS operation; nothing is submitted if the estimate exceeds it. */
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
  /** Request kind on the provider (e.g. Luma "video_edit"); part of the identity. */
  requestType: string;
  /** true only once endpoint, payload, auth and prices were checked against a primary source. */
  contractVerified: boolean;
  resolutions: VfxResolution[];
  /** Longest source (seconds) the provider accepts for this request type. */
  maxSourceSeconds: number;
};

export interface VfxProvider {
  readonly name: string;
  readonly capabilities: VfxCapabilities;
  isAvailable(): boolean;
  /** Concrete model this request runs on (part of the paid-call identity). */
  resolveModel(request: VfxTransformRequest): string;
  /** Provider-resolved creative parameters exactly as they will be sent (strength, controls…); part of the identity. */
  describeRequest(request: VfxTransformRequest): Record<string, unknown>;
  /** Pre-call estimate from VERIFIED prices only; throws when there is no verified price. */
  estimateCostUsd(request: VfxTransformRequest): number;
  /**
   * Free, non-generating preparation (e.g. upload the source to the provider's file store). Runs
   * before the ledger; returns the request with `source.providerFileId` set.
   */
  prepareSource?(request: VfxTransformRequest): Promise<VfxTransformRequest>;
  transformVideo(request: VfxTransformRequest): Promise<VfxAsset>;
  /** Resume an already accepted (billable) job without resubmitting. */
  resumeTransform?(providerJobId: string, request: VfxTransformRequest): Promise<VfxAsset>;
}

/**
 * Product contract for a future "VFX / Transform Scene" UI: what a user may set. Only design; no
 * UI, no new credit system. `toVfxTransformRequest` turns it into the provider-agnostic request.
 */
export type VfxOutputQuality = "draft" | "standard" | "high";
export type TransformSceneInput = {
  /** "Describe la transformación." */
  prompt: string;
  preserveSubject?: boolean;
  strength?: VfxStrength;
  cinematicStyle?: string;
  outputQuality?: VfxOutputQuality;
};

export const TRANSFORM_SCENE_DEFAULTS = { preserveSubject: true, strength: "subtle", outputQuality: "standard" } as const;
export const TRANSFORM_SCENE_PROMPT_MAX = 1000;
export const QUALITY_RESOLUTION: Record<VfxOutputQuality, VfxResolution> = { draft: "360p", standard: "720p", high: "1080p" };
/** Preserving the subject turns on face, pose and trajectory conditioning by default. */
export const SUBJECT_PRESERVING_CONTROLS: VfxEditControls = { faceIdentity: true, pose: "precise", trajectory: { enabled: true } };

export function toVfxTransformRequest(
  input: TransformSceneInput,
  source: VfxSource,
  opts: { range?: { startSeconds: number; endSeconds: number }; aspectRatio: VfxAspectRatio; maxCostUsd: number; negativePrompt?: string; seed?: string; controls?: VfxEditControls },
): VfxTransformRequest {
  const prompt = input.prompt.trim();
  if (!prompt || [...prompt].length > TRANSFORM_SCENE_PROMPT_MAX) throw new Error(`La transformación debe tener entre 1 y ${TRANSFORM_SCENE_PROMPT_MAX} caracteres.`);
  const range = opts.range ?? { startSeconds: 0, endSeconds: source.durationSeconds };
  if (!(range.startSeconds >= 0 && range.endSeconds > range.startSeconds)) throw new Error("Rango de video inválido.");
  if (Math.abs(range.endSeconds - range.startSeconds - source.durationSeconds) > 0.05) throw new Error("El origen debe estar recortado exactamente al rango a transformar.");
  const preserveSubject = input.preserveSubject ?? TRANSFORM_SCENE_DEFAULTS.preserveSubject;
  return {
    source,
    range,
    prompt,
    negativePrompt: opts.negativePrompt,
    aspectRatio: opts.aspectRatio,
    resolution: QUALITY_RESOLUTION[input.outputQuality ?? TRANSFORM_SCENE_DEFAULTS.outputQuality],
    dynamicRange: "sdr",
    preserveSubject,
    strength: input.strength ?? TRANSFORM_SCENE_DEFAULTS.strength,
    controls: opts.controls ?? (preserveSubject ? SUBJECT_PRESERVING_CONTROLS : undefined),
    style: input.cinematicStyle?.trim() || undefined,
    seed: opts.seed,
    maxCostUsd: opts.maxCostUsd,
  };
}

export const vfxSourceSeconds = (r: VfxTransformRequest) => r.source.durationSeconds;
