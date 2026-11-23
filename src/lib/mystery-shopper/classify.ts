import type { Availability, ProductObservation } from "./types";

export function classifyProduct(obs: ProductObservation | null): { availability: Availability; evidence: string } {
  if (!obs || (obs.seenInMenu === null && obs.opened === null)) {
    return { availability: "NO_VERIFICADO", evidence: obs?.blockedReason ?? "El cliente no llegó a ver este producto. No se le asigna un estado de funcionamiento." };
  }
  if (obs.blockedReason) return { availability: "BLOQUEADO", evidence: obs.blockedReason };
  if (obs.seenInMenu === false) return { availability: "NO_DISPONIBLE", evidence: "No aparece en el menú que vio el cliente." };
  if (obs.opened === false) return { availability: "BLOQUEADO", evidence: obs.menuLabel ? `«${obs.menuLabel}» está en el menú, pero no se pudo abrir.` : "Está en el menú, pero no se pudo abrir." };
  if (obs.opened && obs.completedFreeFlow === false) {
    return { availability: "INTERFAZ_SIN_FUNCIONALIDAD_COMPLETA", evidence: obs.limitations[0] ?? "La pantalla abre, pero el recorrido gratuito no se puede terminar." };
  }
  if (obs.opened && obs.completedFreeFlow && obs.limitations.length > 0) {
    return { availability: "CON_LIMITACIONES", evidence: obs.limitations.join(" ") };
  }
  if (obs.opened && obs.completedFreeFlow) return { availability: "DISPONIBLE_Y_FUNCIONAL", evidence: "El recorrido gratuito se completó en la interfaz visible." };
  return { availability: "NO_VERIFICADO", evidence: "Faltan señales visibles para clasificarlo." };
}
