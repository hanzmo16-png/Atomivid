import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { canProduceInternalLongForm } from "@/lib/billing/internal-production";

/** Existing beta access plus the separately authorized internal Long Form account. */
export function canAccessLongFormBeta(user: { id?: string; email?: string; email_confirmed_at?: string } | null): boolean {
  return canPrepareAvatar(user) || canProduceInternalLongForm(user);
}
