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

/** Every message that sends the customer to support says so with this phrase (render-error, customer-error). */
export const SUPPORT_REQUIRED_PHRASE = "Contacta al soporte";

export function requiresSupport(message: string | null | undefined): boolean {
  return Boolean(message && message.includes(SUPPORT_REQUIRED_PHRASE));
}

export function parseStartOutcome(value: unknown): StartOutcome | null {
  const v = value as Partial<StartOutcome> | null;
  if (!v || typeof v !== "object") return null;
  if (v.retry !== "available" && v.retry !== "support") return null;
  if (v.charge !== "none_proven" && v.charge !== "unknown") return null;
  if (typeof v.status !== "string" || !Number.isInteger(v.attempts)) return null;
  return { retry: v.retry, charge: v.charge, status: v.status, attempts: v.attempts as number };
}

export const NO_CHARGE_PROVEN = "No se generó ningún cargo por este intento.";
export const CHARGE_UNKNOWN = "Tu solicitud y el plan confirmado siguen guardados.";

/**
 * The single next step for a failed start, for the request's CURRENT state. null = nothing to say (stale or
 * the page shows another state). Without a server outcome (network error, unreadable reply) the charge is unknown.
 */
export function startNoticeText(
  current: { status: string; attempts: number; retryAvailable: boolean },
  message: string,
  outcome: StartOutcome | null,
): string | null {
  if (outcome && (outcome.status !== current.status || outcome.attempts !== current.attempts)) return null;
  if (current.status !== "script_ready" && current.status !== "failed") return null;
  const charge = outcome?.charge === "none_proven" ? NO_CHARGE_PROVEN : CHARGE_UNKNOWN;
  if (outcome?.retry === "support" || requiresSupport(message)) {
    return `${charge} Repetir ahora no lo resolverá: contacta al soporte con el código antes de volver a intentarlo.`;
  }
  if (current.status === "script_ready") return `${charge} Puedes volver a pulsar «Iniciar producción».`;
  return current.retryAvailable
    ? `${charge} Puedes volver a intentarlo con «Reintentar» (usa uno de los intentos disponibles).`
    : `${charge} Ya no quedan intentos para este plan.`;
}
