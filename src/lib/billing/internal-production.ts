/** Server-only owner entitlement. Supplier charges and spending gates remain enforced. */
export type InternalProductionUser = { id?: string; email_confirmed_at?: string } | null | undefined;

export function isInternalProductionOwner(
  user: InternalProductionUser,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const id = env.INTERNAL_PRODUCTION_OWNER_USER_ID?.trim().toLowerCase();
  return Boolean(id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
    && user?.email_confirmed_at && user.id?.toLowerCase() === id);
}

export const INTERNAL_PRODUCTION_MODES = ["visual", "long_form", "avatar"] as const;
