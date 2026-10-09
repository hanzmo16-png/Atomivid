import { getStripe } from "@/lib/stripe/client";
import { createServiceClient } from "@/lib/supabase/service";
import { handleStripeWebhook } from "@/lib/billing/webhook";

export async function POST(request: Request) {
  return handleStripeWebhook(request, {
    stripe: getStripe,
    service: createServiceClient,
    webhookSecret: () => process.env.STRIPE_WEBHOOK_SECRET,
  });
}
