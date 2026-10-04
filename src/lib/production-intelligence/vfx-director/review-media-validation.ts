import { createHash } from "node:crypto";

export interface ReviewMaterial { assetPath: string; sha256: string }
/** Metadata is only a locator. Approval must refer to the actual bytes. */
export function reviewMaterial(value: unknown, jobId: string): ReviewMaterial | null {
  if (!value || typeof value !== "object") return null;
  const { assetPath, sha256 } = value as Partial<ReviewMaterial>;
  if (typeof assetPath !== "string" || typeof sha256 !== "string"
    || !assetPath.startsWith(`${jobId}/`) || assetPath.includes("..") || assetPath.includes("\\")
    || !/\.(png|jpg|jpeg|mp4)$/.test(assetPath) || !/^[a-f0-9]{64}$/.test(sha256)) return null;
  return { assetPath, sha256 };
}
export function matchesReviewBytes(material: ReviewMaterial, bytes: Buffer | null): boolean {
  return bytes !== null && createHash("sha256").update(bytes).digest("hex") === material.sha256;
}
