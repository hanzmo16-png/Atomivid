/**
 * Delivery / Storage policy. A MASTER is always ONE progressive MP4 (moov first)
 * when it fits the configured storage limit (Supabase Pro: 500 MB); splitting into
 * parts is only a legacy fallback. Signed URLs are generated on demand and never
 * persisted (they are credentials). Nothing here deletes assets.
 * Reuses output-policy.ts (size estimates, storage error classes) and output-upload.ts (TUS).
 */
import { z } from "zod";
import { configuredStorageMaxBytes } from "@/lib/video/long-form/output-policy";

export const ASSET_TYPES = ["MASTER", "PREVIEW", "HLS", "INTERMEDIATE", "MANIFEST"] as const;
export type DeliveryAssetType = (typeof ASSET_TYPES)[number];

export const RETENTION: Record<DeliveryAssetType, { policy: "keep" | "days"; days: number | null; why: string }> = {
  MASTER: { policy: "keep", days: null, why: "approved deliverable; never auto-deleted" },
  MANIFEST: { policy: "keep", days: null, why: "checksums and provenance of the master" },
  PREVIEW: { policy: "days", days: 90, why: "regenerable from the master" },
  HLS: { policy: "days", days: 30, why: "regenerable streaming copy" },
  INTERMEDIATE: { policy: "days", days: 30, why: "segments, parts, work files; regenerable" },
};

export const DeliveryRecordSchema = z.object({
  projectId: z.string(),
  assetType: z.enum(ASSET_TYPES),
  storagePath: z.string().refine((p) => !/[?&]token=/.test(p), "store paths, never signed URLs"),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive(),
  durationSeconds: z.number().positive().nullable(),
  contentType: z.string(),
  progressive: z.boolean().nullable(),
  createdAt: z.string(),
  retentionPolicy: z.enum(["keep", "days"]),
  retentionDays: z.number().int().positive().nullable(),
});
export type DeliveryRecord = z.infer<typeof DeliveryRecordSchema>;

export const PRO_STORAGE_LIMIT_BYTES = 500 * 1024 * 1024;

export type MasterPlan = { mode: "single_file" | "parts_legacy"; reasons: string[]; limitBytes: number };

/** Single progressive file whenever it fits; parts only when the configured limit truly forbids it. */
export function planMasterDelivery(sizeBytes: number, env: Record<string, string | undefined> = process.env): MasterPlan {
  const limit = configuredStorageMaxBytes(env) ?? PRO_STORAGE_LIMIT_BYTES;
  if (sizeBytes <= limit) return { mode: "single_file", limitBytes: limit, reasons: [`${sizeBytes} B <= limit ${limit} B: one progressive MP4 (video/mp4, moov first)`] };
  return { mode: "parts_legacy", limitBytes: limit, reasons: [`${sizeBytes} B exceeds limit ${limit} B: verified parts + manifest; raise the storage limit to deliver a single file`] };
}

export function deliveryRecord(r: Omit<DeliveryRecord, "retentionPolicy" | "retentionDays">): DeliveryRecord {
  const ret = RETENTION[r.assetType];
  return DeliveryRecordSchema.parse({ ...r, retentionPolicy: ret.policy, retentionDays: ret.days });
}

/** Checks a first chunk of an MP4: ftyp then moov before mdat => progressive playback. */
export function isProgressiveMp4(head: Buffer): boolean {
  let pos = 0;
  while (pos + 8 <= head.length) {
    const size = head.readUInt32BE(pos), type = head.toString("latin1", pos + 4, pos + 8);
    if (type === "moov") return true;
    if (type === "mdat") return false;
    if (size < 8) return false;
    pos += size;
  }
  return false;
}

/** Anonymous verification criteria for a delivered master URL (the stage performs the HTTP calls). */
export type AnonymousCheck = { rangeStatus: number; contentType: string | null; acceptRanges: string | null; probeSeconds: number; expectedSeconds: number; progressive: boolean };
export function masterUrlAcceptable(c: AnonymousCheck): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (c.rangeStatus !== 206) reasons.push(`range request returned ${c.rangeStatus}, expected 206`);
  if (c.contentType !== "video/mp4") reasons.push(`content-type ${c.contentType}`);
  if (c.acceptRanges !== "bytes") reasons.push("no Accept-Ranges: bytes");
  if (Math.abs(c.probeSeconds - c.expectedSeconds) > 0.2) reasons.push(`duration ${c.probeSeconds} != ${c.expectedSeconds}`);
  if (!c.progressive) reasons.push("moov after mdat: not progressive");
  return { ok: reasons.length === 0, reasons };
}
