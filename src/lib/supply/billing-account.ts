/** Existing FLUX/Recraft adapters use the same configured fal.ai billing account.
 * This is an accounting/display identity, NOT proof of pooled atomic admission. */
export function billingAccountKey(provider: string): string {
  return provider === "flux" || provider === "recraft" ? "fal" : provider;
}

export function billingAccountProviders(provider: string): readonly string[] {
  return billingAccountKey(provider) === "fal" ? ["recraft", "flux"] : [provider];
}

export const SUPPLY_REFRESH_INTERVAL_MS = 300_000;
