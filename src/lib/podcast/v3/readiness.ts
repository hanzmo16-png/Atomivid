/**
 * Podcast 3.0 — verificación previa de proveedores (pura; las lecturas de saldo son GET gratuitos que hace el worker).
 * Regla: si un proveedor que el episodio NECESITA no tiene saldo verificado suficiente, no se empieza (ningún cargo).
 * Un saldo que no se puede verificar (sin credencial, error, modalidad no prepago) cuenta como NO listo: no se adivina.
 */
import type { CapacitySnapshot } from "@/lib/production-intelligence/capacity/capacity";
import type { ProviderNeeds } from "./pipeline";

export type ReadinessSnapshots = { elevenlabs?: CapacitySnapshot | null; heygen?: CapacitySnapshot | null };

export function studioReadiness(needs: ProviderNeeds, s: ReadinessSnapshots): string | null {
  const why: string[] = [];
  if (needs.ttsChars > 0) {
    const e = s.elevenlabs;
    if (!e || e.health !== "OK" || e.available == null || e.unit !== "character") why.push("ElevenLabs: saldo de caracteres no verificable ahora mismo.");
    else if (e.available < needs.ttsChars) why.push(`ElevenLabs: quedan ${e.available.toLocaleString("es-MX")} caracteres y el episodio necesita ${needs.ttsChars.toLocaleString("es-MX")}.`);
  }
  if (needs.avatarUsd > 0) {
    const h = s.heygen;
    if (!h || h.health !== "OK" || h.available == null || h.unit !== "usd") why.push("HeyGen: saldo prepago en USD no verificable ahora mismo.");
    else if (h.available + 1e-9 < needs.avatarUsd) why.push(`HeyGen: saldo USD ${h.available.toFixed(2)} y el episodio necesita hasta USD ${needs.avatarUsd.toFixed(2)}.`);
  }
  if (needs.imagesUsd > 0) why.push("Recreaciones de pago: el adaptador de imágenes de pago del estudio no está conectado.");
  return why.length ? why.join(" ") : null;
}
