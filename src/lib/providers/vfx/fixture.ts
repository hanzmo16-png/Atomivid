/** Deterministic VFX provider: no network, no cost. For tests and local runs only. */
import { createHash } from "node:crypto";
import type { VfxAsset, VfxProvider, VfxTransformRequest } from "./types";

export const fixtureVfxProvider: VfxProvider = {
  name: "fixture",
  capabilities: { id: "fixture", models: ["fixture-vfx"], formats: ["video/mp4"], aspectRatios: ["9:16", "16:9", "1:1"], timeoutMs: 1000, maxRetries: 0, contractVerified: true, maxRangeSeconds: { "fixture-vfx": 60 } },
  isAvailable: () => true,
  resolveModel: () => "fixture-vfx",
  estimateCostUsd: () => 0,
  async transformVideo(request: VfxTransformRequest): Promise<VfxAsset> {
    const tag = createHash("sha256").update(`${request.source.sha256}|${request.prompt}`).digest("hex").slice(0, 16);
    return { kind: "vfx_transform", buffer: Buffer.from(`fixture-vfx:${tag}`), mimeType: "video/mp4", extension: "mp4", model: "fixture-vfx", costUsd: 0, costBasis: "estimated", durationSeconds: request.range.endSeconds - request.range.startSeconds };
  },
};
