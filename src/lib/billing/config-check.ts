import { PLAN_ORDER, planPriceIdEnvVar, type PlanId } from "./plans";

/**
 * Comprobación interna de configuración para el flujo de facturación —
 * nunca devuelve valores, solo presencia (booleano) y, para la clave de
 * Stripe, el modo (test/live/unknown) derivado del prefijo público y
 * documentado del propio SDK de Stripe (sk_test_/sk_live_ — no es un
 * secreto, es una convención de formato). No es una ruta pública: es una
 * función de servidor pura, pensada para pruebas unitarias o para uso
 * interno, nunca expuesta como endpoint HTTP.
 */
export type StripeKeyMode = "test" | "live" | "unknown" | "missing";

export type BillingConfigCheck = {
  hasStripeSecretKey: boolean;
  stripeSecretKeyMode: StripeKeyMode;
  /** Un Price ID configurado por plan (starter/pro/business) — ver plans.ts. */
  hasPlanPriceId: Record<PlanId, boolean>;
  hasSupabaseUrl: boolean;
  hasSupabaseAnonKey: boolean;
  hasSupabaseServiceRoleKey: boolean;
};

function detectStripeKeyMode(secretKey: string | undefined): StripeKeyMode {
  if (!secretKey) return "missing";
  if (secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_")) return "test";
  if (secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_")) return "live";
  return "unknown";
}

export function checkBillingConfig(
  env: Partial<Record<string, string | undefined>> = process.env,
): BillingConfigCheck {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const hasPlanPriceId = Object.fromEntries(
    PLAN_ORDER.map((id) => [id, !!env[planPriceIdEnvVar(id)]?.trim()]),
  ) as Record<PlanId, boolean>;

  return {
    hasStripeSecretKey: !!secretKey,
    stripeSecretKeyMode: detectStripeKeyMode(secretKey),
    hasPlanPriceId,
    hasSupabaseUrl: !!env.NEXT_PUBLIC_SUPABASE_URL?.trim(),
    hasSupabaseAnonKey: !!env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim(),
    hasSupabaseServiceRoleKey: !!env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  };
}
