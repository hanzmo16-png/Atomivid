import type { SupabaseClient } from "@supabase/supabase-js";
import { falBillingKey } from "@/lib/supply/fal";

/**
 * Recraft (fal.ai) readiness BEFORE a Long Form confirmation locks the image source.
 *
 * Why (audit 2026-10-23): confirming with Recraft writes `reel_image_source='recraft'` in the same update that
 * confirms the plan, and database triggers make that choice immutable. When the `recraft` supply policy is
 * still closed (enabled=false, caps 0 — its state in production) or the fal balance cannot be read, the start
 * click then answers 503 forever: the request is stuck with a choice that can no longer be changed.
 *
 * Read-only: one `pi_supply_state` RPC. A merely stale balance is fine (the start click refreshes it once with
 * the fal billing GET); a closed policy or no way to read the balance is not. Returns a reason, or null.
 */
export async function recraftProductionBlocker(service: Pick<SupabaseClient, "rpc">, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  if (!falBillingKey(env)) return "el saldo de fal.ai no se puede verificar en este entorno";
  const { data, error } = await service.rpc("pi_supply_state", { p_provider: "recraft" });
  const state = data as { level?: string; reason?: string } | null;
  if (error || !state) return "el control de gasto de Recraft no está disponible";
  if (state.level === "UNKNOWN" && state.reason === "policy unconfigured") return "los límites de gasto de Recraft todavía no están configurados";
  if (state.level === "RED") return "el saldo de Recraft no alcanza para producir";
  return null;
}

export function recraftBlockedMessage(reason: string): string {
  return `Recraft no está listo para producir: ${reason}. Elige las imágenes predeterminadas o pide habilitar Recraft. No se confirmó ni cobró nada.`;
}
