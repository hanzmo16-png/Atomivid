import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe/client";
import { createServiceClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createServiceClient>;

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return NextResponse.json({ error: "Webhook no configurado" }, { status: 400 });
  }

  const body = await request.text();

  let event: Stripe.Event;
  try {
    event = await getStripe().webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Firma inválida";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const service = createServiceClient();

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
        const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
        await upsertSubscription(service, userId, subscription, customerId);
      }
      break;
    }

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
        await upsertSubscription(service, userId, subscription, customerId);
      }
      break;
    }

    default:
      break;
  }

  return NextResponse.json({ received: true });
}

async function findUserIdByCustomerId(
  service: ServiceClient,
  customerId: string,
): Promise<string | null> {
  const { data } = await service
    .from("subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

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

  await service.from("subscriptions").upsert(
    {
      user_id: userId,
      stripe_customer_id: resolvedCustomerId,
      stripe_subscription_id: subscription.id,
      status: subscription.status,
      price_id: item?.price.id ?? null,
      current_period_end: currentPeriodEnd,
      cancel_at_period_end: subscription.cancel_at_period_end,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
}
