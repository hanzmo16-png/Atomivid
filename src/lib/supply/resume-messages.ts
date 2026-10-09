import { START_SUPPLY_UNAVAILABLE } from "./readiness";

/** Customer-facing outcome of "Reanudar ahora" (nothing here starts a new attempt or a new paid call). */
export const RESUME_MESSAGE = {
  dispatched: "Producción reanudada. Puedes cerrar esta página: el avance se guarda y lo verás al volver.",
  too_soon: "La producción se reanudó hace un momento. Espera unos minutos antes de volver a intentarlo.",
  already_claimed: "La producción ya se está reanudando. Espera unos minutos.",
  not_waiting: "Esta producción ya no está en espera; recarga la página para ver su estado.",
  uncertain_paid_call: "Hay un cobro de un proveedor pendiente de confirmar en esta producción. No se reanuda para no pagar dos veces; contacta al soporte.",
  frozen: "Esta producción es una prueba privada y no puede reanudarse desde aquí.",
  supply_unavailable: START_SUPPLY_UNAVAILABLE,
} as const;
