/** Server-side, single-account preparation access. Empty configuration denies all. */
export function canPrepareAvatar(
  user: { email?: string; email_confirmed_at?: string } | null,
  ownerEmail = process.env.AVATAR_PREPARATION_OWNER_EMAIL,
): boolean {
  const owner = ownerEmail?.trim().toLowerCase();
  return Boolean(owner && user?.email_confirmed_at && user.email?.toLowerCase() === owner);
}

export const PREPARATION_MAX_SECONDS = 45;
