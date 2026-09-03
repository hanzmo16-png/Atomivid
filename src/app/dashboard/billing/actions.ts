"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe/client";

const PRICE_ID = process.env.STRIPE_PRICE_ID;

async function getSiteUrl(): Promise<string> {
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (envUrl) return envUrl;
  const origin = (await headers()).get("origin");
  return origin ?? "http://localhost:3000";
}

export async function createCheckoutSession() {
  if (!PRICE_ID) {
    redirect("/dashboard/billing?error=Falta+configurar+STRIPE_PRICE_ID");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const siteUrl = await getSiteUrl();
  const service = createServiceClient();

  const { data: existing } = await service
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const existingCustomerId = (existing as { stripe_customer_id: string | null } | null)
    ?.stripe_customer_id;

  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: PRICE_ID, quantity: 1 }],
    client_reference_id: user.id,
    customer: existingCustomerId ?? undefined,
    customer_email: existingCustomerId ? undefined : (user.email ?? undefined),
    subscription_data: {
      metadata: { supabase_user_id: user.id },
    },
    success_url: `${siteUrl}/dashboard/billing?checkout=success`,
    cancel_url: `${siteUrl}/dashboard/billing?checkout=canceled`,
  });

  if (!session.url) {
    throw new Error("Stripe no devolvió una URL de checkout");
  }

  redirect(session.url);
}

export async function createPortalSession() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const siteUrl = await getSiteUrl();
  const service = createServiceClient();

  const { data: subscription } = await service
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const customerId = (subscription as { stripe_customer_id: string | null } | null)
    ?.stripe_customer_id;

  if (!customerId) {
    redirect("/dashboard/billing?error=Todavía+no+tienes+una+suscripción");
  }

  const portalSession = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${siteUrl}/dashboard/billing`,
  });

  redirect(portalSession.url);
}
