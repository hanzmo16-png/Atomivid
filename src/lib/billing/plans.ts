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

/**
 * What every plan delivers today, as a customer can use it. Avatar videos are NOT listed: avatar is a
 * private beta (canPrepareAvatar) and is not sold as available; monthlyAvatarLimit stays only as the
 * quota the server would apply if that ever changes. Durations match the form (30, 60 or 90 s).
 */
const REEL_INCLUDES = [
  "Videos de 30, 60 o 90 segundos en 1080×1920",
  "Revisas y editas el guion antes del video final",
  "Narración con IA en español o inglés",
  "Cancela cuando quieras",
];

export const PLAN_CONFIGS: Record<PlanId, PlanConfig> = {
  starter: {
    id: "starter",
    name: "Starter",
    priceUsdPerMonth: 19,
    monthlyNormalLimit: 15,
    monthlyAvatarLimit: 0,
    includes: [
      "15 Reels/Shorts verticales al mes",
      ...REEL_INCLUDES,
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceUsdPerMonth: 49,
    monthlyNormalLimit: 30,
    monthlyAvatarLimit: 5,
    includes: [
      "30 Reels/Shorts verticales al mes",
      ...REEL_INCLUDES,
    ],
  },
  business: {
    id: "business",
    name: "Business",
    priceUsdPerMonth: 129,
    monthlyNormalLimit: 60,
    monthlyAvatarLimit: 15,
    includes: [
      "60 Reels/Shorts verticales al mes",
      ...REEL_INCLUDES,
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
 * A plan can be bought only when the server has both its Stripe price and the Stripe key. Pages use this
 * to show a real purchase button or an honest "not enabled yet" state instead of a checkout that fails.
 */
export function isPlanPurchasable(id: PlanId, env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env[planPriceIdEnvVar(id)]?.trim() && env.STRIPE_SECRET_KEY?.trim());
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
