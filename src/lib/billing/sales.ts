import { PLAN_ORDER, isPlanPurchasable } from "./plans";

/**
 * True when a new customer can actually buy a Reels/Shorts plan on this deployment (a Stripe price and the
 * Stripe key are configured for at least one plan). Public pages use it to decide whether to invite people
 * to register and buy, or to join the launch list instead — purchase is never presented as open when it isn't.
 */
export function salesOpen(env: Record<string, string | undefined> = process.env): boolean {
  return PLAN_ORDER.some((id) => isPlanPurchasable(id, env));
}
