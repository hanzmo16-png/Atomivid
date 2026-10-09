import { NextResponse } from "next/server";
import type Stripe from "stripe";
import type { createServiceClient } from "@/lib/supabase/service";
import { logBillingError, SupabaseQueryError } from "./checkout-error";

type ServiceClient = ReturnType<typeof createServiceClient>;

export type WebhookDependencies = {
  stripe: () => Pick<Stripe, "webhooks" | "subscriptions">;
  service: () => ServiceClient;
  webhookSecret: () => string | undefined;
};

export async function handleStripeWebhook(request: Request, deps: WebhookDependencies) {
  const signature = request.headers.get("stripe-signature");
  const webhookSecret = deps.webhookSecret();

  if (!signature || !webhookSecret) {
    return NextResponse.json({ error: "Webhook no configurado" }, { status: 400 });
  }

  const body = await request.text();

  let event: Stripe.Event;
  try {
    event = await deps.stripe().webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch {
    return NextResponse.json({ error: "Firma inválida" }, { status: 400 });
  }

  try {
    const service = deps.service();

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session.client_reference_id;
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id;
        const customerId =
          typeof session.customer === "string" ? session.customer : session.customer?.id;

        if (userId && subscriptionId) {
          const subscription = await deps.stripe().subscriptions.retrieve(subscriptionId);
          await upsertSubscription(service, userId, subscription, customerId);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const customerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer.id;

        const userId =
          subscription.metadata?.supabase_user_id ||
          (await findUserIdByCustomerId(service, customerId));

        if (userId) {
          // Delivery order is not guaranteed. Replaying an old "active" snapshot must
          // not restore access after cancellation. Read current state before saving.
          const current = await deps.stripe().subscriptions.retrieve(subscription.id);
          await upsertSubscription(service, userId, current, customerId);
        }
        break;
      }

      default:
        break;
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    logBillingError("stripe webhook", error);
    // Supabase returns errors as values. Never acknowledge an unpersisted event:
    // Stripe can redeliver a non-2xx response without asking the customer to pay again.
    return NextResponse.json({ error: "No se pudo actualizar la suscripción" }, { status: 500 });
  }
}

async function findUserIdByCustomerId(
  service: ServiceClient,
  customerId: string,
): Promise<string | null> {
  const { data, error } = await service
    .from("subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  if (error) throw new SupabaseQueryError(error.code);
  return (data as { user_id: string } | null)?.user_id ?? null;
}

async function upsertSubscription(
  service: ServiceClient,
  userId: string,
  subscription: Stripe.Subscription,
  customerId?: string,
) {
  const item = subscription.items.data[0];
  const currentPeriodEnd = item
    ? new Date(item.current_period_end * 1000).toISOString()
    : null;
  const resolvedCustomerId =
    customerId ??
    (typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id);

  const row = {
      user_id: userId,
      stripe_customer_id: resolvedCustomerId,
      stripe_subscription_id: subscription.id,
      status: subscription.status,
      price_id: item?.price.id ?? null,
      current_period_end: currentPeriodEnd,
      cancel_at_period_end: subscription.cancel_at_period_end,
      updated_at: new Date().toISOString(),
    };
  // A delayed cancellation for a previous subscription must not cancel its
  // replacement. Match both identities atomically for terminal states.
  const terminal = subscription.status === "canceled" || subscription.status === "incomplete_expired";
  const { error } = terminal
    ? await service.from("subscriptions").update(row).eq("user_id", userId).eq("stripe_subscription_id", subscription.id)
    : await service.from("subscriptions").upsert(row, { onConflict: "user_id" });
  if (error) throw new SupabaseQueryError(error.code);
}
