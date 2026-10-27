import type { SupabaseClient } from "@supabase/supabase-js";
import { releaseUnusedJobSupply } from "@/lib/supply/job";
import { encodeStoredFailure } from "./failure-action";
import { isExhaustedStaleAttempt, type RenderStartRow } from "./render-guard";
import { EXHAUSTED_ATTEMPT_CLOSED } from "./start-outcome";

/**
 * Cierra como fallo terminal un intento colgado que ya no tiene intentos restantes (ver isExhaustedStaleAttempt).
 * Compare-and-set sobre el MISMO intento (estado, número y hora de inicio): si el worker volvió a latir o alguien
 * lo cambió, no toca nada. Libera solo la parte no usada de la reserva; los cobros inciertos siguen retenidos.
 * Lo usan la ruta de render y las páginas (Historial y detalle), para que el estado final no dependa de un botón.
 */
export async function closeExhaustedStaleAttempt(
  service: SupabaseClient,
  row: RenderStartRow & { id: string },
  nowMs: number = Date.now(),
): Promise<"closed" | "not_applicable" | "changed"> {
  if (!isExhaustedStaleAttempt(row, nowMs)) return "not_applicable";
  let query = service.from("video_requests")
    .update({ status: "failed", progress_stage: null, error_message: encodeStoredFailure(EXHAUSTED_ATTEMPT_CLOSED, "retry") })
    .eq("id", row.id).eq("status", "processing").eq("render_attempts", row.render_attempts);
  query = row.render_started_at ? query.eq("render_started_at", row.render_started_at) : query.is("render_started_at", null);
  const closed = await query.select("id");
  if (closed.error) throw closed.error;
  if (!closed.data?.length) return "changed";
  await releaseUnusedJobSupply(service, row.id, row.render_attempts).catch(() => undefined);
  return "closed";
}
