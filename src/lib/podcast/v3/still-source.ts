/**
 * Where the studio worker reads a participant's still photo (two-shot / over-the-shoulder listener plates):
 * - a photo uploaded in the wizard («foto:<path>») lives in the «videos» bucket under the owner's podcast-studio folder;
 * - an existing avatar's source photo lives where the avatar flow stored it: the «avatar-uploads» bucket
 *   (RECORDING_BUCKET). Reading it from «videos» found nothing and failed the episode with «FOTO» after voice and a
 *   paid clip (real P2, 2026-10-27, episode 0de4b445).
 * Either way the path must belong to the episode owner; anything else is refused before any download.
 */
import { RECORDING_BUCKET } from "@/lib/video/avatar/recording";

export const STUDIO_BUCKET = "videos";
export type StillSource = { bucket: string; path: string };
export function stillSource(owner: string, ref: string, avatarSourcePhoto: string | null | undefined): StillSource {
  const fromWizard = ref.startsWith("foto:");
  const path = fromWizard ? ref.slice(5) : avatarSourcePhoto ?? "";
  if (!path || !path.startsWith(`${owner}/`) || path.includes("..")) throw new Error("Avatar sin foto fija disponible");
  return { bucket: fromWizard ? STUDIO_BUCKET : RECORDING_BUCKET, path };
}
