import type { SupabaseClient } from "@supabase/supabase-js";
import { releaseUnusedJobSupply } from "@/lib/supply/job";
import { encodeStoredFailure } from "./failure-action";
import { isExhaustedStaleAttempt, isRenderStale, type RenderStartRow } from "./render-guard";
import { MAX_RENDER_ATTEMPTS } from "./limits";
import { EXHAUSTED_ATTEMPT_CLOSED, STALE_LONG_FORM_ATTEMPT_CLOSED } from "./start-outcome";

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

/**
 * Long Form colgado (sin latido durante LONG_FORM_HEARTBEAT_STALE_MS) que AÚN tiene intentos: antes solo
 * se mostraba «Reintentar» en la tarjeta mientras la fila seguía «processing» para siempre (en cola sin
 * salida). Se cierra como fallo RECUPERABLE (acción «retry») en cuanto el Historial o el detalle lo leen,
 * sin cron ni secretos. Compare-and-set sobre el MISMO intento y el MISMO latido: si el worker volvió a
 * latir, no toca nada. El reintento reutiliza lo ya pagado (reuse_paid_results); aquí no se cobra nada.
 */
export function isStaleLongFormAttempt(row: RenderStartRow, nowMs: number = Date.now()): boolean {
  return row.mode === "long_form" && row.render_attempts < MAX_RENDER_ATTEMPTS && isRenderStale(row, nowMs);
}

function heartbeat(progress: unknown): string | null {
  const updatedAt = progress && typeof progress === "object" ? (progress as { updatedAt?: unknown }).updatedAt : null;
  return typeof updatedAt === "string" ? updatedAt : null;
}

export async function closeStaleLongFormAttempt(
  service: SupabaseClient,
  row: RenderStartRow & { id: string },
  nowMs: number = Date.now(),
): Promise<"closed" | "not_applicable" | "changed"> {
  if (!isStaleLongFormAttempt(row, nowMs)) return "not_applicable";
  let query = service.from("video_requests")
    .update({ status: "failed", progress_stage: null, long_form_stage: null, long_form_progress: null,
      error_message: encodeStoredFailure(STALE_LONG_FORM_ATTEMPT_CLOSED, "retry") })
    .eq("id", row.id).eq("status", "processing").eq("mode", "long_form").eq("render_attempts", row.render_attempts)
    .is("supply_wait_started_at", null);
  query = row.render_started_at ? query.eq("render_started_at", row.render_started_at) : query.is("render_started_at", null);
  const beat = heartbeat(row.long_form_progress);
  query = beat ? query.eq("long_form_progress->>updatedAt", beat) : query.is("long_form_progress", null);
  const closed = await query.select("id");
  if (closed.error) throw closed.error;
  if (!closed.data?.length) return "changed";
  await releaseUnusedJobSupply(service, row.id, row.render_attempts).catch(() => undefined);
  return "closed";
}

/** Historial y detalle: el estado final de un intento colgado no depende de abrir una página concreta ni de un botón. */
export async function closeStaleAttempt(
  service: SupabaseClient,
  row: RenderStartRow & { id: string },
  nowMs: number = Date.now(),
): Promise<{ outcome: "closed" | "not_applicable" | "changed"; errorMessage: string | null }> {
  if (isExhaustedStaleAttempt(row, nowMs)) {
    return { outcome: await closeExhaustedStaleAttempt(service, row, nowMs), errorMessage: EXHAUSTED_ATTEMPT_CLOSED };
  }
  if (isStaleLongFormAttempt(row, nowMs)) {
    return { outcome: await closeStaleLongFormAttempt(service, row, nowMs), errorMessage: STALE_LONG_FORM_ATTEMPT_CLOSED };
  }
  return { outcome: "not_applicable", errorMessage: null };
}
