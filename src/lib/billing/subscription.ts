export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"] as const;

export function isSubscriptionActive(status: string | null | undefined): boolean {
  return !!status && (ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/**
 * Estados en los que la cuenta YA tiene una suscripción viva en Stripe aunque no dé acceso: el cobro falló o quedó a
 * medias. Se resuelven actualizando el método de pago en el portal de Stripe, nunca con una segunda suscripción
 * (sería un doble cobro cuando la primera se recupere).
 */
export const RECOVERABLE_SUBSCRIPTION_STATUSES = ["past_due", "unpaid", "incomplete"] as const;

export function isSubscriptionRecoverable(status: string | null | undefined): boolean {
  return !!status && (RECOVERABLE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/** Un nuevo Checkout solo se abre sin suscripción, o con una cancelada/expirada. */
export function blocksNewCheckout(status: string | null | undefined): boolean {
  return isSubscriptionActive(status) || isSubscriptionRecoverable(status);
}

export const STATUS_LABEL: Record<string, string> = {
  none: "Sin suscripción",
  active: "Activa",
  trialing: "En prueba",
  past_due: "Pago pendiente",
  canceled: "Cancelada",
  unpaid: "Impaga",
  incomplete: "Incompleta",
  incomplete_expired: "Expirada",
};
