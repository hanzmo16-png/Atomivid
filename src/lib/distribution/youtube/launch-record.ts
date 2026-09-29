/**
 * Launch record: everything needed to publish a master MANUALLY, prepared by ATOMIVID and
 * never published by it. A record can only be built for a master whose Final Cut gate allows
 * distribution; the YouTube video id is attached AFTER the human publishes.
 */
import { z } from "zod";
import { distributionEligible, type EditorialRecord, type FinalCutFlags } from "@/lib/final-cut/gate";
import { createLink, YOUTUBE_VIDEO_ID, type DeliveredMaster, type ProductionLink } from "./link";

export const LaunchRecordSchema = z.object({
  launchId: z.string().min(1),
  productionId: z.string().min(1),
  masterId: z.string().min(1),
  masterHash: z.string().regex(/^[a-f0-9]{64}$/),
  masterStoragePath: z.string().min(1),
  finalCutStatus: z.enum(["EDITORIAL_QA_PASS", "FINAL_CUT_DISABLED"]),
  finalCutReportId: z.string().nullable(),
  title: z.string().min(1).max(100),
  description: z.string().max(5000),
  chapters: z.array(z.object({ startSeconds: z.number().nonnegative(), title: z.string().min(1) })),
  language: z.string().min(2),
  thumbnailReference: z.string().nullable(),
  visibilityIntent: z.enum(["private", "unlisted", "public"]),
  channelId: z.string().regex(/^UC[\w-]{22}$/),
  youtubeVideoId: z.string().regex(YOUTUBE_VIDEO_ID).nullable(),
  publishedAt: z.string().nullable(),
  publishedBy: z.string().nullable(),
  status: z.enum(["PREPARED", "PUBLISHED_MANUALLY"]),
  createdAt: z.string(),
});
export type LaunchRecord = z.infer<typeof LaunchRecordSchema>;

export class LaunchGateError extends Error {}

export function prepareLaunchRecord(input: Omit<LaunchRecord, "launchId" | "finalCutStatus" | "finalCutReportId" | "youtubeVideoId" | "publishedAt" | "publishedBy" | "status">, ctx: { editorial: EditorialRecord | null; flags: FinalCutFlags; masters: DeliveredMaster[] }): LaunchRecord {
  const gate = distributionEligible(ctx.editorial, ctx.flags);
  if (!gate.eligible) throw new LaunchGateError(`launch refused: ${gate.reason}`);
  const m = ctx.masters.find((x) => x.projectId === input.productionId && x.assetType === "MASTER" && x.checksumSha256 === input.masterHash);
  if (!m) throw new LaunchGateError("masterHash is not a delivered MASTER of this production");
  if (ctx.editorial && ctx.editorial.masterId !== input.masterId) throw new LaunchGateError(`editorial QA passed on ${ctx.editorial.masterId}, not on ${input.masterId}`);
  const lastReport = ctx.editorial?.history.filter((h) => h.reportId).pop()?.reportId ?? null;
  return LaunchRecordSchema.parse({ ...input, launchId: `${input.productionId}:${input.masterHash.slice(0, 12)}`, finalCutStatus: ctx.flags.enabled ? "EDITORIAL_QA_PASS" : "FINAL_CUT_DISABLED", finalCutReportId: lastReport, youtubeVideoId: null, publishedAt: null, publishedBy: null, status: "PREPARED" });
}

/** After the person published manually: attach the video id and derive the production link (idempotent for the same id). */
export function recordManualPublication(r: LaunchRecord, p: { youtubeVideoId: string; publishedAt: string; publishedBy: string }, masters: DeliveredMaster[]): { record: LaunchRecord; link: ProductionLink } {
  if (r.youtubeVideoId && r.youtubeVideoId !== p.youtubeVideoId) throw new LaunchGateError(`launch ${r.launchId} already records video ${r.youtubeVideoId}`);
  const record = LaunchRecordSchema.parse({ ...r, youtubeVideoId: p.youtubeVideoId, publishedAt: p.publishedAt, publishedBy: p.publishedBy, status: "PUBLISHED_MANUALLY" });
  const link = createLink({ projectId: r.productionId, requestId: null, masterChecksumSha256: r.masterHash, masterStoragePath: r.masterStoragePath, channelId: r.channelId, videoId: p.youtubeVideoId, publishedAt: p.publishedAt, linkedAt: p.publishedAt, linkedBy: p.publishedBy }, masters);
  return { record, link };
}
