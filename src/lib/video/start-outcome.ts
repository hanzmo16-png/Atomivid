/**
 * Typed result of a production start that did not go through (render route → configure page → video page).
 * The notice and the retry action are derived from this contract, never from the status alone:
 * - `retry`: "available" when repeating can help; "support" when only an operator can fix the cause.
 * - `charge`: "none_proven" only when the server proved nothing ran (nothing reserved, or the attempt was
 *   still queued and its reservation was released). Anything else is "unknown" and no zero-charge claim is made.
 * - `status`/`attempts`: the request state the outcome describes; a different state makes the notice stale.
 */
export type StartRetry = "available" | "support";
export type StartCharge = "none_proven" | "unknown";
export type StartOutcome = { retry: StartRetry; charge: StartCharge; status: string; attempts: number };

export function parseStartOutcome(value: unknown): StartOutcome | null {
  const v = value as Partial<StartOutcome> | null;
  if (!v || typeof v !== "object") return null;
  if (v.retry !== "available" && v.retry !== "support") return null;
  if (v.charge !== "none_proven" && v.charge !== "unknown") return null;
  if (typeof v.status !== "string" || !Number.isInteger(v.attempts)) return null;
  return { retry: v.retry, charge: v.charge, status: v.status, attempts: v.attempts as number };
}

/** Text stored on a stalled attempt closed by a new start. No zero-charge claim: that attempt may have paid steps. */
export const EXHAUSTED_ATTEMPT_CLOSED = "El último intento dejó de dar señales de avance y ya no quedan intentos para este video. Lo que ya quedó guardado se conserva; para volver a intentarlo, crea una nueva solicitud desde «Nuevo video».";
export const STALE_ATTEMPT_CLOSED = "El intento anterior dejó de dar señales de avance y se cerró al iniciar uno nuevo. Lo que ya quedó guardado se conserva.";
export const NO_CHARGE_PROVEN = "No se generó ningún cargo por este intento.";
export const CHARGE_UNKNOWN = "Tu solicitud y el plan confirmado siguen guardados.";

/**
 * The single next step for a failed start, for the request's CURRENT state. null = nothing to say (stale or
 * the page shows another state). Decided only by the typed outcome, never by the message wording. Without a
 * server outcome (network error, unreadable reply) the charge is unknown; support then comes only from the
 * action stored with the request's failure (`supportRequired`).
 */
export function startNoticeText(
  current: { status: string; attempts: number; retryAvailable: boolean; supportRequired?: boolean },
  outcome: StartOutcome | null,
): string | null {
  if (outcome && (outcome.status !== current.status || outcome.attempts !== current.attempts)) return null;
  if (current.status !== "script_ready" && current.status !== "failed") return null;
  const charge = outcome?.charge === "none_proven" ? NO_CHARGE_PROVEN : CHARGE_UNKNOWN;
  // Either typed source: this start's outcome, or the action the server stored with the failure.
  if (outcome?.retry === "support" || current.supportRequired) {
    return `${charge} Repetir ahora no lo resolverá: contacta al soporte con el código antes de volver a intentarlo.`;
  }
  if (current.status === "script_ready") return `${charge} Puedes volver a pulsar «Iniciar producción».`;
  return current.retryAvailable
    ? `${charge} Puedes volver a intentarlo con «Reintentar» (usa uno de los intentos disponibles).`
    : `${charge} Ya no quedan intentos para este plan.`;
}

/** The outcome still describes the request as it is now (same status and attempt). */
export function outcomeApplies(outcome: StartOutcome | null, current: { status: string; attempts: number }): outcome is StartOutcome {
  return Boolean(outcome && outcome.status === current.status && outcome.attempts === current.attempts);
}
