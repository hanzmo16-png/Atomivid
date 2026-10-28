import { decodeStoredFailure } from "@/lib/video/failure-action";
import { MATERIAL_UNAVAILABLE_PREFIX } from "./material-preflight";

/** True when the stored failure is the material-unavailable stop (never a support-tagged failure). */
export function isMaterialUnavailableFailure(errorMessage: string | null | undefined): boolean {
  if (!errorMessage) return false;
  const decoded = decodeStoredFailure(errorMessage);
  return decoded.action !== "support" && decoded.message.startsWith(MATERIAL_UNAVAILABLE_PREFIX);
}
