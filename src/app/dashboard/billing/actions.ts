"use server";

import { displayPrice } from "@/lib/billing/display-price";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe/client";
import { buildCheckoutUrl } from "@/lib/billing/checkout";
import { SupabaseQueryError, classifyBillingError, logBillingError } from "@/lib/billing/checkout-error";
import { MissingEnvVarError } from "@/lib/env-errors";

/**
 * No es un error real — es una señal interna para salir del try/catch de
 * createPortalSession sin arriesgar que redirect() (que funciona lanzando
 * una excepción especial de Next.js) se ejecute DENTRO del try y termine
 * capturada por nuestro propio catch de abajo.
 */
class NoSubscriptionError extends Error {}

async function getSiteUrl(): Promise<string> {
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (envUrl) return envUrl;
  const origin = (await headers()).get("origin");
  return origin ?? "http://localhost:3000";
}

/**
 * El cliente de Supabase no lanza excepciones por errores de consulta —
 * devuelve { data, error } — así que sin esta comprobación explícita un
 * fallo aquí (p. ej. SUPABASE_SERVICE_ROLE_KEY inválida) se ignoraba en
 * silencio y el flujo seguía como si el usuario no tuviera cliente de
 * Stripe todavía, en vez de reportar el error real.
 */
async function getExistingCustomerId(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await service
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new SupabaseQueryError(error.code);
  }

  return (data as { stripe_customer_id: string | null } | null)?.stripe_customer_id ?? null;
}

export async function createCheckoutSession() {
  if (process.env.VERCEL_ENV === "preview") redirect("/dashboard/billing?error=Vista+previa:+solo+consulta,+sin+modificar+suscripciones.");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  if (!process.env.STRIPE_SECRET_KEY?.trim().startsWith("sk_test_")) redirect("/dashboard/billing?error=Los+pagos+reales+están+desactivados.");
  let checkoutUrl: string;
  try {
    // STRIPE_PRICE_ID se lee aquí dentro, no a nivel de módulo: si se lee
    // arriba (como antes), el valor queda capturado en el cierre del
    // módulo la primera vez que se carga — el mismo riesgo que ya se evitó
    // deliberadamente para STRIPE_SECRET_KEY en getStripe().
    const priceId = process.env.STRIPE_PRICE_ID?.trim();
    if (!priceId) {
      throw new MissingEnvVarError("STRIPE_PRICE_ID");
    }

    if (!displayPrice(await getStripe().prices.retrieve(priceId))) throw new Error("Test price unavailable");
    const siteUrl = await getSiteUrl();
    const service = createServiceClient();

    checkoutUrl = await buildCheckoutUrl(user, {
      createCheckoutSession: (params) => getStripe().checkout.sessions.create(params),
      getExistingCustomerId: (userId) => getExistingCustomerId(service, userId),
      priceId,
      siteUrl,
    });
  } catch (err) {
    logBillingError("createCheckoutSession", err);
    redirect(`/dashboard/billing?error=${encodeURIComponent(classifyBillingError(err))}`);
  }

  redirect(checkoutUrl);
}

export async function createPortalSession() {
  if (process.env.VERCEL_ENV === "preview") redirect("/dashboard/billing?error=Vista+previa:+solo+consulta,+sin+modificar+suscripciones.");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  if (!process.env.STRIPE_SECRET_KEY?.trim().startsWith("sk_test_")) redirect("/dashboard/billing?error=Los+pagos+reales+están+desactivados.");
  let portalUrl: string;
  try {
    const siteUrl = await getSiteUrl();
    const service = createServiceClient();
    const customerId = await getExistingCustomerId(service, user.id);

    if (!customerId) {
      throw new NoSubscriptionError();
    }

    const portalSession = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${siteUrl}/dashboard/billing`,
    });
    portalUrl = portalSession.url;
  } catch (err) {
    if (err instanceof NoSubscriptionError) {
      redirect("/dashboard/billing?error=Todavía+no+tienes+una+suscripción");
    }
    logBillingError("createPortalSession", err);
    redirect(`/dashboard/billing?error=${encodeURIComponent(classifyBillingError(err))}`);
  }

  redirect(portalUrl);
}
