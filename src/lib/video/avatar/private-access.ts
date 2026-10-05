import { isInternalProductionOwner } from "@/lib/billing/internal-production";

/** Server-side, explicit legacy beta or owner account. Empty configuration denies all. */
export function canPrepareAvatar(
  user: { id?: string; email?: string; email_confirmed_at?: string } | null,
  ownerEmail = process.env.AVATAR_PREPARATION_OWNER_EMAIL,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (isInternalProductionOwner(user, env)) return true;
  const owner = ownerEmail?.trim().toLowerCase();
  return Boolean(owner && user?.email_confirmed_at && user.email?.toLowerCase() === owner);
}

export const PREPARATION_MAX_SECONDS = 45;
