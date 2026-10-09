import type { DeliveryStatus } from "@/lib/podcast/editor/verify";

export const DELIVERY_LABEL: Record<DeliveryStatus["state"], string> = {
  sin_entrega: "En edición (sin COMPLETO.json)",
  entrega_invalida: "Entrega no válida",
  pendiente_verificar: "Entregado · falta verificar integridad",
  terminado: "Terminado y verificado",
};
