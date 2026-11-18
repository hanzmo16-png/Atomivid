/**
 * Pure rules (safe for any component); the database write lives in reel-cancel-server.ts.
 * Cancelación de un Reel en cola o en producción, iniciada por su dueño. Reutiliza la máquina de estados existente
 * (processing → failed, acción «retry»): no hay estado nuevo ni migración. Es un compare-and-set sobre el MISMO
 * intento y la MISMA etapa leída; si el worker avanzó entretanto, no toca nada («changed»).
 *
 * Sin cobros nuevos: el worker comprueba el intento antes de cada etapa (attemptState.update) y antes de cada envío
 * de pago (guardNewPaidCalls), así que tras cancelar no se envía ninguna llamada de pago nueva. Una llamada que ya
 * estaba en curso termina y queda registrada en el ledger, como en cualquier otro fallo.
 */
export const REEL_CANCELLED_MESSAGE =
  "Cancelaste esta producción. Después de cancelar no se envía ningún cobro nuevo; lo que ya quedó guardado se conserva y puedes reintentar cuando quieras.";

/** «uploading»: el video ya está hecho; cancelarlo solo tiraría el resultado. */
const CANCELLABLE_STAGES: readonly (string | null)[] = [null, "queued", "voice", "footage", "music", "render"];

export type CancellableRow = { id: string; user_id: string; mode: string | null; status: string; render_attempts: number; progress_stage: string | null };

export function canCancelReel(row: { mode?: string | null; status: string; progress_stage: string | null }): boolean {
  return (row.mode ?? "visual") === "visual" && row.status === "processing" && CANCELLABLE_STAGES.includes(row.progress_stage ?? null);
}

export function isCancelledFailure(stored: string | null | undefined): boolean {
  return Boolean(stored?.startsWith(REEL_CANCELLED_MESSAGE));
}
