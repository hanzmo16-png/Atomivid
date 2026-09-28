/**
 * Upload foundation. V1 flow: ATOMIVID prepares everything, the user publishes
 * manually. A PRIVATE upload request can be prepared behind UPLOAD_PRIVATE (off
 * by default). SCHEDULED/PUBLIC are refused while AUTO_PUBLISH is false.
 * Note: videos uploaded through an unverified/unaudited API project are locked to
 * private by YouTube; public integrated publishing needs the Google audit.
 */
import { assertCapability, type DistributionFlags } from "./capabilities";
import type { LaunchPackage } from "./launch-package";

export type UploadRequest = {
  channelId: string;
  mediaStoragePath: string;
  snippet: { title: string; description: string; tags: string[] };
  status: { privacyStatus: "private"; selfDeclaredMadeForKids: false; containsSyntheticMedia: true };
};

export class UploadRefusedError extends Error {}

export function prepareUpload(flags: DistributionFlags, pkg: LaunchPackage, mediaStoragePath: string, visibility: "private" | "scheduled" | "public"): UploadRequest {
  if (visibility !== "private") throw new UploadRefusedError(`${visibility} is refused: AUTO_PUBLISH=${flags.AUTO_PUBLISH}; the user publishes manually`);
  assertCapability(flags, "UPLOAD_PRIVATE");
  if (pkg.approval.status !== "approved") throw new UploadRefusedError("Launch package is not approved by the user");
  return {
    channelId: pkg.channelId,
    mediaStoragePath,
    snippet: { title: pkg.titleCandidates[0].text, description: pkg.description, tags: pkg.keywords },
    // AI-generated realistic content must be disclosed on YouTube.
    status: { privacyStatus: "private", selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
  };
}
