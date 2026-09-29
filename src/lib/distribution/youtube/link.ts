/**
 * Production <-> YouTube link: ATOMIVID request -> master (delivery asset checksum) ->
 * YouTube video id -> analytics snapshots. The link is created by a person after manual
 * publication (AUTO_PUBLISH is false); it is idempotent on (projectId, videoId) and it
 * refuses a master checksum that is not a delivered MASTER of that project.
 */
import { z } from "zod";

export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export const ProductionLinkSchema = z.object({
  linkKey: z.string(),
  projectId: z.string().min(1),
  requestId: z.string().min(1).nullable(),
  masterChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  masterStoragePath: z.string().min(1),
  channelId: z.string().regex(/^UC[\w-]{22}$/),
  videoId: z.string().regex(YOUTUBE_VIDEO_ID),
  publishedAt: z.string().nullable(),
  linkedAt: z.string(),
  linkedBy: z.string().min(1),
  status: z.enum(["linked", "unlinked"]),
});
export type ProductionLink = z.infer<typeof ProductionLinkSchema>;

export type DeliveredMaster = { projectId: string; assetType: string; storagePath: string; checksumSha256: string };

export class LinkError extends Error {}

export function createLink(input: Omit<ProductionLink, "linkKey" | "status">, masters: DeliveredMaster[]): ProductionLink {
  const m = masters.find((x) => x.projectId === input.projectId && x.assetType === "MASTER" && x.checksumSha256 === input.masterChecksumSha256);
  if (!m) throw new LinkError(`no delivered MASTER of ${input.projectId} has checksum ${input.masterChecksumSha256.slice(0, 12)}…`);
  if (m.storagePath !== input.masterStoragePath) throw new LinkError("masterStoragePath does not match the delivered master");
  if (/[?&]token=|^https?:\/\//i.test(input.masterStoragePath)) throw new LinkError("storage PATH expected, never a signed URL");
  return ProductionLinkSchema.parse({ ...input, linkKey: `${input.projectId}:${input.videoId}`, status: "linked" });
}

/** Idempotent upsert: the same (project, video) keeps one row; a second video for the same master is a new link. */
export function upsertLink(store: Map<string, ProductionLink>, link: ProductionLink): "inserted" | "unchanged" | "updated" {
  const cur = store.get(link.linkKey);
  if (!cur) { store.set(link.linkKey, link); return "inserted"; }
  if (JSON.stringify(cur) === JSON.stringify(link)) return "unchanged";
  if (cur.masterChecksumSha256 !== link.masterChecksumSha256) throw new LinkError(`${link.linkKey} already links a different master; unlink first`);
  store.set(link.linkKey, link); return "updated";
}
