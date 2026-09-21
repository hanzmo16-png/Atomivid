/**
 * Los 3 paquetes de Atomivid — definidos a partir de la auditoría de costo
 * real por video (2026-09-21): un video con avatar cuesta ~15-25x más que
 * uno normal (dominado por HeyGen, ~$0.0385/seg de audio), así que cada
 * plan separa cuota de videos normales y de videos con avatar en vez de un
 * solo contador combinado (el defecto anterior de MONTHLY_VIDEO_LIMIT, que
 * no distinguía modo). Precios/paquetes definidos por el usuario con
 * margen objetivo ~65-90% bruto sobre costo de proveedores, ancla de
 * mercado: Pollo AI ($10-29/mes), Pictory ($25-35/mes), InVideo AI
 * ($28-50/mes).
 *
 * El Price ID real de cada plan se crea en el dashboard de Stripe (no
 * desde este código — mismo patrón que STRIPE_PRICE_ID antes de esto) y
 * se configura por variable de entorno (ver .env.example). Mientras una
 * variable no esté configurada, ese plan sigue mostrándose en la UI (con
 * su precio/cuota) pero el checkout falla con un error claro en vez de un
 * crash — mismo patrón de MissingEnvVarError que el resto del billing.
 */
export type PlanId = "starter" | "pro" | "business";

export type PlanConfig = {
  id: PlanId;
  name: string;
  priceUsdPerMonth: number;
  /** Videos sin avatar permitidos por mes natural. */
  monthlyNormalLimit: number;
  /** Videos con avatar permitidos por mes natural — 0 significa que el plan no incluye avatar. */
  monthlyAvatarLimit: number;
  includes: string[];
};

export const PLAN_ORDER: PlanId[] = ["starter", "pro", "business"];

export const PLAN_CONFIGS: Record<PlanId, PlanConfig> = {
  starter: {
    id: "starter",
    name: "Starter",
    priceUsdPerMonth: 19,
    monthlyNormalLimit: 15,
    monthlyAvatarLimit: 0,
    includes: [
      "15 videos normales al mes (hasta 60s)",
      "Revisa y edita el guion antes del video final",
      "Narración en español e inglés",
      "Cancela cuando quieras",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceUsdPerMonth: 49,
    monthlyNormalLimit: 30,
    monthlyAvatarLimit: 5,
    includes: [
      "30 videos normales al mes",
      "5 videos con avatar al mes (hasta 45s)",
      "Revisa y edita el guion antes del video final",
      "Narración en español e inglés",
      "Cancela cuando quieras",
    ],
  },
  business: {
    id: "business",
    name: "Business",
    priceUsdPerMonth: 129,
    monthlyNormalLimit: 60,
    monthlyAvatarLimit: 15,
    includes: [
      "60 videos normales al mes",
      "15 videos con avatar al mes (hasta 60s)",
      "Revisa y edita el guion antes del video final",
      "Narración en español e inglés",
      "Cancela cuando quieras",
    ],
  },
};

/** Nombre exacto de la variable de entorno con el Price ID real de Stripe para este plan. */
export function planPriceIdEnvVar(id: PlanId): string {
  return `STRIPE_PRICE_ID_${id.toUpperCase()}`;
}

export function getPlanPriceId(id: PlanId): string | undefined {
  return process.env[planPriceIdEnvVar(id)]?.trim() || undefined;
}

/**
 * Resuelve qué plan corresponde a un price_id guardado en
 * `subscriptions.price_id` (columna ya existente, poblada por el webhook
 * de Stripe) — null si no coincide con ningún plan configurado todavía
 * (variable de entorno sin definir, o un price_id heredado/desconocido).
 */
export function getPlanByPriceId(priceId: string | null | undefined): PlanConfig | null {
  if (!priceId) return null;
  for (const id of PLAN_ORDER) {
    if (getPlanPriceId(id) === priceId) return PLAN_CONFIGS[id];
  }
  return null;
}
