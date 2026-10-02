/**
 * Paid-call wrapper for VFX / Transform Scene (VFX Provider V1). Same protections as voice/music
 * (gated-providers.ts): ledger row before any request, local idempotency key, stored result reused
 * with zero calls, fail-closed on uncertain outcomes, no retry of billing-uncertain refusals.
 *
 * Order of checks, all before any ledger row or provider call:
 *   1. fixture → passes through (no cost);
 *   2. provider contract not verified → refuse (contract_unverified);
 *   3. a valid stored result for this identity → reuse (0 calls, 0 cost);
 *   4. estimate from VERIFIED prices only, then estimate + committed + reserved ≤ hard cap and
 *      estimate ≤ the operation max → otherwise refuse (budget_exceeded);
 *   5. guardPaidCall (ledger RESERVED → SUBMITTED → COMMITTED / RECONCILIATION_REQUIRED …).
 *
 * Identity = what determines the result: source sha256 (even when the provider works from its own
 * file id), provider, model, request type, prompt, negative prompt, range/duration, aspect ratio,
 * resolution, dynamic range, edit controls, strength, style, seed — plus the provider-resolved
 * parameters exactly as sent. Never the source URL or file id, never render_attempts.
 *
 * Source transport: `provider.prepareSource` (e.g. Luma Files API → file_id) runs before the ledger
 * (it generates nothing); the resulting file id is cached per source sha256 so a retry reuses it.
 */
import { stableHash } from "@/lib/production-intelligence/canonical";
import { assertVfxBudget, type VfxBudget } from "@/lib/providers/vfx/pricing";
import type { VfxAsset, VfxProvider, VfxTransformRequest } from "@/lib/providers/vfx/types";
import { GenerativeProviderError } from "@/lib/providers/types";
import { classifyPaidCallError, guardPaidCall, paidCallKey, type PaidCallSpec } from "./gate";
import { paidResultPath, sha256Hex, UNSTORED_REF, type PaidResultStore } from "./result-store";
import type { PaidCallDeps } from "./gated-providers";

export const VFX_SHOT_PREFIX = "vfx:";
export const VFX_METHOD = "video_transform";

type StoredVfx = { kind: "vfx_transform"; videoPath: string; sha256: string; bytes: number; model: string; mimeType: string; extension: string; durationSeconds?: number; width?: number; height?: number; providerJobId?: string; costUsd: number };

const ms = (s: number) => Math.round(s * 1000);

export function vfxIdentity(provider: VfxProvider, r: VfxTransformRequest) {
  return {
    sourceSha256: r.source.sha256,
    sourceDurationMs: ms(r.source.durationSeconds),
    provider: provider.name,
    model: provider.resolveModel(r),
    requestType: provider.capabilities.requestType,
    prompt: r.prompt.trim(),
    negativePrompt: r.negativePrompt?.trim() || null,
    rangeMs: [ms(r.range.startSeconds), ms(r.range.endSeconds)],
    aspectRatio: r.aspectRatio,
    resolution: r.resolution,
    dynamicRange: r.dynamicRange,
    preserveSubject: r.preserveSubject,
    strength: r.strength,
    controls: r.controls ?? null,
    style: r.style?.trim() || null,
    seed: r.seed ?? null,
    providerParams: provider.describeRequest(r),
  };
}

export function vfxCallSpec(requestId: string, provider: VfxProvider, r: VfxTransformRequest, reservedUsd: number): PaidCallSpec {
  const fingerprint = vfxIdentity(provider, r);
  const model = fingerprint.model;
  return { projectId: requestId, shotId: `${VFX_SHOT_PREFIX}${stableHash(fingerprint, 16)}`, provider: provider.name, model, method: VFX_METHOD, inputFingerprint: fingerprint, reservedUsd: Math.max(0, reservedUsd) };
}

async function storeVfx(results: PaidResultStore, requestId: string, key: string, a: VfxAsset): Promise<string> {
  const videoPath = paidResultPath(requestId, key, a.extension);
  const jsonPath = paidResultPath(requestId, key, "json");
  try {
    await results.putBytes(videoPath, a.buffer, a.mimeType);
    const meta: StoredVfx = { kind: "vfx_transform", videoPath, sha256: sha256Hex(a.buffer), bytes: a.buffer.byteLength, model: a.model, mimeType: a.mimeType, extension: a.extension, durationSeconds: a.durationSeconds, width: a.width, height: a.height, providerJobId: a.providerJobId, costUsd: a.costUsd };
    await results.putJson(jsonPath, meta);
    return jsonPath;
  } catch (err) {
    // Already paid: commit with an unloadable ref rather than lose the row; a later attempt refuses instead of paying again.
    return `${UNSTORED_REF}${err instanceof Error ? err.message.slice(0, 160) : "storage error"}`;
  }
}

/** Loads only a sha256-verified VFX result; anything else (ai_video sidecar, corrupt bytes) is null. */
export async function loadVfx(results: PaidResultStore, resultRef: string): Promise<VfxAsset | null> {
  if (resultRef.startsWith(UNSTORED_REF)) return null;
  const meta = await results.getJson<StoredVfx>(resultRef);
  if (!meta || meta.kind !== "vfx_transform") return null;
  const buffer = await results.getBytes(meta.videoPath);
  if (!buffer || buffer.byteLength !== meta.bytes || sha256Hex(buffer) !== meta.sha256) return null;
  return { kind: "vfx_transform", buffer, mimeType: meta.mimeType, extension: meta.extension, model: meta.model, costUsd: meta.costUsd, costBasis: "estimated", providerJobId: meta.providerJobId, durationSeconds: meta.durationSeconds, width: meta.width, height: meta.height };
}

export type VfxCallDeps = PaidCallDeps & { provider: VfxProvider; budget: VfxBudget };

/** Where the provider file id for a given source sha256 is cached (no secret, no URL). */
export const vfxSourceRefPath = (requestId: string, provider: string, sha256: string) => `${requestId}/vfx-sources/${provider}-${sha256}.json`;

/** Free source preparation (e.g. Luma Files API upload) with the file id reused across attempts. */
async function prepareSourceDurably(deps: VfxCallDeps, request: VfxTransformRequest): Promise<VfxTransformRequest> {
  if (!deps.provider.prepareSource) return request;
  const refPath = vfxSourceRefPath(deps.requestId, deps.provider.name, request.source.sha256);
  const cached = request.source.providerFileId ? null : await deps.results.getJson<{ fileId?: string }>(refPath).catch(() => null);
  const withRef = cached?.fileId ? { ...request, source: { ...request.source, providerFileId: cached.fileId } } : request;
  const prepared = await deps.provider.prepareSource(withRef);
  const fileId = prepared.source.providerFileId;
  if (prepared.source.sha256 !== request.source.sha256) throw new GenerativeProviderError("VFX: la preparación cambió la identidad del origen", deps.provider.name, "invalid_response", undefined, undefined, "not_sent");
  if (fileId && fileId !== cached?.fileId) await deps.results.putJson(refPath, { fileId, sha256: request.source.sha256 }).catch(() => undefined);
  return prepared;
}
export type GatedVfxResult = VfxAsset & { reused: boolean; costUsd: number; key?: string };

export async function gatedVfxTransform(deps: VfxCallDeps, request: VfxTransformRequest): Promise<GatedVfxResult> {
  const { provider } = deps;
  if (provider.name === "fixture") return { ...(await provider.transformVideo(request)), reused: false, costUsd: 0 };
  if (!provider.capabilities.contractVerified) {
    throw new GenerativeProviderError(`VFX ${provider.name}: contrato no verificado; no se envía ninguna solicitud pagada`, provider.name, "contract_unverified", undefined, undefined, "not_sent");
  }
  const spec0 = vfxCallSpec(deps.requestId, provider, request, 0);
  for (const ordinal of [0, 1]) {
    const stored = await loadVfx(deps.results, paidResultPath(deps.requestId, paidCallKey(spec0, ordinal), "json"));
    if (stored) return { ...stored, reused: true, costUsd: 0, key: paidCallKey(spec0, ordinal) };
  }
  const estimate = provider.estimateCostUsd(request);
  assertVfxBudget(provider.name, estimate, request.maxCostUsd, deps.budget);
  request = await prepareSourceDurably(deps, request);
  const spec = { ...spec0, reservedUsd: estimate };
  let acceptedJobId: string | undefined;
  const onAccepted = async (id: string) => {
    acceptedJobId = id;
    await request.onProviderJobAccepted?.(id);
  };
  const guarded = await guardPaidCall<VfxAsset>(deps.ledger, spec, {
    call: async ({ key }) => {
      const a = await provider.transformVideo({ ...request, maxCostUsd: Math.min(request.maxCostUsd, estimate), onProviderJobAccepted: onAccepted });
      if (a.kind !== "vfx_transform") throw new GenerativeProviderError("VFX: el proveedor devolvió un recurso que no es vfx_transform", provider.name, "invalid_response", undefined, a.providerJobId, "uncertain");
      return { result: a, costUsd: a.costUsd, resultRef: await storeVfx(deps.results, deps.requestId, key, a), providerJobId: a.providerJobId };
    },
    ...(provider.resumeTransform
      ? {
          resume: async (jobId: string, { key }: { key: string }) => {
            const a = await provider.resumeTransform!(jobId, request);
            return { result: a, costUsd: a.costUsd, resultRef: await storeVfx(deps.results, deps.requestId, key, a), providerJobId: jobId };
          },
        }
      : {}),
    load: (ref) => loadVfx(deps.results, ref),
    // A failure after the provider accepted the job keeps the job id: resume, never resubmit.
    classify: (err) => (acceptedJobId ? { kind: "accepted", providerJobId: acceptedJobId } : classifyPaidCallError(err)),
    maxRejectedRetries: 0,
  });
  return { ...guarded.result, reused: guarded.reused, costUsd: guarded.costUsd, key: guarded.key };
}
