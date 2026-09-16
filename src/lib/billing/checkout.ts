import type Stripe from "stripe";
import { CheckoutUrlMissingError } from "./checkout-error";

/**
 * Lógica de creación de la Checkout Session, separada de la Server Action
 * (que solo puede vivir en actions.ts) para poder probarla con un Stripe y
 * un lookup de cliente simulados, sin red ni credenciales reales — mismo
 * patrón de inyección de dependencias ya usado en este proyecto para
 * selectIfOwned/seed-request.
 */
export type CreateCheckoutSessionFn = Stripe["checkout"]["sessions"]["create"];

export async function buildCheckoutUrl(
  user: { id: string; email?: string | null },
  deps: {
    createCheckoutSession: CreateCheckoutSessionFn;
    getExistingCustomerId: (userId: string) => Promise<string | null>;
    priceId: string;
    siteUrl: string;
  },
): Promise<string> {
  const existingCustomerId = await deps.getExistingCustomerId(user.id);

  const session = await deps.createCheckoutSession({
    mode: "subscription",
    line_items: [{ price: deps.priceId, quantity: 1 }],
    client_reference_id: user.id,
    customer: existingCustomerId ?? undefined,
    customer_email: existingCustomerId ? undefined : (user.email ?? undefined),
    subscription_data: {
      metadata: { supabase_user_id: user.id },
    },
    success_url: `${deps.siteUrl}/dashboard/billing?checkout=success`,
    cancel_url: `${deps.siteUrl}/dashboard/billing?checkout=canceled`,
  });

  if (!session.url) {
    throw new CheckoutUrlMissingError();
  }
  return session.url;
}
