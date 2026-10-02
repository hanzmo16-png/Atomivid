/**
 * Luma adapter for VFX / Transform Scene (VFX Provider V1).
 *
 * VERIFIED (2026-10-02) against Luma's official TypeScript SDK `lumaai` 1.19.1 (npm, published by
 * LumaAI support+api@lumalabs.ai, generated from Luma's OpenAPI spec by Stainless):
 *   - base URL https://api.lumalabs.ai/dream-machine/v1, auth `Authorization: Bearer <key>`;
 *   - POST /generations/video/modify with { generation_type: "modify_video", model: "ray-2" |
 *     "ray-flash-2", mode: adhere_1..3 | flex_1..3 | reimagine_1..3, media: { url }, prompt?,
 *     first_frame?, callback_url? };
 *   - GET /generations/{id} → state queued | dreaming | completed | failed, assets.video;
 *   - GET /credits → { credit_balance } in USD cents (read-only, no generation).
 *
 * NOT VERIFIED, so `contractVerified` stays false and transformVideo() never sends a request:
 *   - whether Modify Video on Dream Machine v1 is still Luma's CURRENT video-to-video API. Search
 *     results describe a newer Ray3.2 `video_edit` request on the Agents API (agents.lumalabs.ai);
 *     its official SDK (npm luma-agents 0.1.2, 2026-05-08) only exposes image/image_edit, and
 *     docs.lumalabs.ai, docs.agents.lumalabs.ai and lumalabs.ai are blocked by this environment's
 *     network policy (EGRESS_BLOCKED);
 *   - the price (see pricing.ts), the per-model range limits and the output resolution/fps;
 *   - which API the configured LUMA_API_KEY belongs to (Dream Machine vs Agents).
 * A human must confirm the contract on the primary docs before `LUMA_VFX_CONTRACT_VERIFIED` and the
 * rates can flip to true. Same deliberate policy as video-gen/kling.ts.
 */
import { GenerativeProviderError } from "../types";
import { estimateVfxCostUsd, type VfxOutputShape } from "./pricing";
import { vfxRangeSeconds, type VfxAsset, type VfxProvider, type VfxStrength, type VfxTransformRequest } from "./types";

export const LUMA_API_BASE = "https://api.lumalabs.ai/dream-machine/v1";
export const LUMA_MODIFY_PATH = "/generations/video/modify";
export const LUMA_MODIFY_MODELS = ["ray-2", "ray-flash-2"] as const;
export type LumaModifyModel = (typeof LUMA_MODIFY_MODELS)[number];
export const LUMA_MODIFY_MODES = ["adhere_1", "adhere_2", "adhere_3", "flex_1", "flex_2", "flex_3", "reimagine_1", "reimagine_2", "reimagine_3"] as const;
export type LumaModifyMode = (typeof LUMA_MODIFY_MODES)[number];

/** Flip only after a human confirms the current contract and prices on Luma's primary docs. */
export const LUMA_VFX_CONTRACT_VERIFIED = false;
export const LUMA_VFX_CONTRACT_SOURCE = "npm lumaai@1.19.1 (OpenAPI-generated SDK, 2026-01-21)";

/**
 * UNVERIFIED limits/shape, used only to plan (spend plans, estimates shown as unverified):
 * search snippets of the Modify Video page give max 10 s (ray-2) / 15 s (ray-flash-2), 100 MB.
 */
export const LUMA_PLANNING_LIMITS = { maxRangeSeconds: { "ray-2": 10, "ray-flash-2": 15 }, maxBytes: 100 * 1024 * 1024 } as const;
/** UNVERIFIED output shape assumed for planning (the pricing examples use 720p at 24 fps). */
export const LUMA_PLANNING_OUTPUT = { shortSide: 720, fps: 24 } as const;

/**
 * Product strength → Modify mode band (verified names; the SDK documents the bands, not the order
 * inside a band, so the middle level of each band is used): subtle keeps motion and structure,
 * balanced lets the environment change, strong lets the prompt take over.
 */
const STRENGTH_MODE: Record<VfxStrength, LumaModifyMode> = { subtle: "adhere_2", balanced: "flex_2", strong: "reimagine_2" };

const fail = (message: string, reason: GenerativeProviderError["reason"]) => new GenerativeProviderError(message, "luma", reason, undefined, undefined, "not_sent");
const apiKey = () => process.env.LUMA_API_KEY?.trim();

export function lumaModelFor(request: Pick<VfxTransformRequest, "quality">): LumaModifyModel {
  return request.quality === "draft" ? "ray-flash-2" : "ray-2";
}

export function lumaModeFor(request: Pick<VfxTransformRequest, "strength" | "preserveSubject">): LumaModifyMode {
  // Preserving the subject never goes to the "reimagine" band, whatever the strength.
  if (request.preserveSubject && request.strength === "strong") return "flex_3";
  return STRENGTH_MODE[request.strength];
}

/** Output shape used for planning estimates (720p short side at 24 fps, unverified). */
export function lumaPlanningOutput(request: Pick<VfxTransformRequest, "aspectRatio" | "range">): VfxOutputShape {
  const s = LUMA_PLANNING_OUTPUT.shortSide;
  const [w, h] = request.aspectRatio === "9:16" ? [s, Math.round((s * 16) / 9)] : request.aspectRatio === "16:9" ? [Math.round((s * 16) / 9), s] : [s, s];
  return { width: w, height: h, fps: LUMA_PLANNING_OUTPUT.fps, durationSeconds: Math.max(0, request.range.endSeconds - request.range.startSeconds) };
}

/** Pure: the exact body POST /generations/video/modify would receive. No credentials, no network. */
export function buildLumaModifyPayload(request: VfxTransformRequest) {
  const url = request.source.url?.trim();
  if (!url || !/^https:\/\//.test(url)) throw fail("Luma: el video de origen debe ser una URL HTTPS", "invalid_request");
  const model = lumaModelFor(request);
  const seconds = vfxRangeSeconds(request);
  if (!(seconds > 0) || seconds > LUMA_PLANNING_LIMITS.maxRangeSeconds[model]) throw fail(`Luma: el tramo debe durar entre 0 y ${LUMA_PLANNING_LIMITS.maxRangeSeconds[model]} s para ${model}`, "invalid_request");
  const parts = [request.prompt.trim()];
  if (request.style) parts.push(`Style: ${request.style}.`);
  if (request.negativePrompt?.trim()) parts.push(`Avoid: ${request.negativePrompt.trim()}`);
  const prompt = parts.join("\n\n");
  if (!request.prompt.trim() || [...prompt].length > 2000) throw fail("Luma: prompt vacío o demasiado largo", "invalid_request");
  return { generation_type: "modify_video" as const, model, mode: lumaModeFor(request), media: { url }, prompt };
}

/**
 * The one free, read-only call: GET /credits (balance in USD cents, per the official SDK). It
 * authenticates the key without creating any generation. Not called by the pipeline.
 */
export async function lumaCreditsPreflight(fetchImpl: typeof fetch = fetch): Promise<{ authenticated: boolean; status: number; balanceUsd?: number }> {
  const key = apiKey();
  if (!key) throw fail("Luma: falta LUMA_API_KEY", "not_configured");
  const res = await fetchImpl(`${LUMA_API_BASE}/credits`, { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403) return { authenticated: false, status: res.status };
  if (!res.ok) throw fail(`Luma: preflight de créditos respondió HTTP ${res.status}`, "upstream_error");
  const body = (await res.json().catch(() => null)) as { credit_balance?: unknown } | null;
  const cents = typeof body?.credit_balance === "number" && Number.isFinite(body.credit_balance) ? body.credit_balance : undefined;
  return { authenticated: true, status: res.status, balanceUsd: cents === undefined ? undefined : cents / 100 };
}

const unverified = () =>
  fail(
    "Luma: el contrato actual de video-to-video (Modify Video en Dream Machine v1 vs Ray3.2 video_edit en la Agents API) y su precio " +
      "no están verificados contra la documentación primaria en este entorno — nunca se envía una solicitud pagada con un contrato no confirmado.",
    "contract_unverified",
  );

export const lumaVfxProvider: VfxProvider = {
  name: "luma",
  capabilities: {
    id: "luma",
    models: [...LUMA_MODIFY_MODELS],
    formats: ["video/mp4"],
    aspectRatios: ["9:16", "16:9", "1:1"],
    timeoutMs: 600_000,
    maxRetries: 0,
    contractVerified: LUMA_VFX_CONTRACT_VERIFIED,
    maxRangeSeconds: { ...LUMA_PLANNING_LIMITS.maxRangeSeconds },
  },
  isAvailable: () => Boolean(apiKey()),
  resolveModel: (request) => lumaModelFor(request),
  estimateCostUsd: (request) => estimateVfxCostUsd("luma", lumaModelFor(request), lumaPlanningOutput(request)),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by VfxProvider; never read while the contract is unverified.
  async transformVideo(request: VfxTransformRequest): Promise<VfxAsset> {
    throw unverified();
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- same as transformVideo.
  async resumeTransform(providerJobId: string, request: VfxTransformRequest): Promise<VfxAsset> {
    throw unverified();
  },
};
