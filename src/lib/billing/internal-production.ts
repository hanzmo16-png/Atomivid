/** Server-side, explicit owner grant for Long Form only. No Stripe subscription is created. */
export type InternalProductionUser = { id?: string; email_confirmed_at?: string } | null | undefined;

export function canProduceInternalLongForm(
  user: InternalProductionUser,
  configuredId = process.env.INTERNAL_LONG_FORM_USER_ID,
): boolean {
  const id = configuredId?.trim().toLowerCase();
  return Boolean(id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
    && user?.email_confirmed_at && user.id?.toLowerCase() === id);
}
