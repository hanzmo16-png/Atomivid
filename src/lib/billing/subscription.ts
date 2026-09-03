export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"] as const;

export function isSubscriptionActive(status: string | null | undefined): boolean {
  return !!status && (ACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
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
