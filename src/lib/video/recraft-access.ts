import { isInternalProductionOwner, type InternalProductionUser } from "@/lib/billing/internal-production";

/**
 * Who may choose «Imágenes IA con Recraft» (Reel and Long Form). Server-only, decided from the authenticated user,
 * never from the browser or the dispatch payload:
 * - everyone, only when RECRAFT_REEL_ENABLED=true (general release; off by default);
 * - otherwise only the confirmed internal owner account: the controlled pilot. The web reads
 *   INTERNAL_PRODUCTION_OWNER_USER_ID; the render worker receives the same value as RECRAFT_PILOT_OWNER_USER_ID so that
 *   no other owner-only path of the worker is switched on by it.
 * The web checks it when the choice is saved and the worker checks it again before reserving or paying anything.
 * Choosing Recraft never funds it: supply policy, balance, per-request budget and spend caps still apply.
 */
export function recraftAllowedFor(user: InternalProductionUser, env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.RECRAFT_REEL_ENABLED?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  const owner = env.RECRAFT_PILOT_OWNER_USER_ID?.trim() || env.INTERNAL_PRODUCTION_OWNER_USER_ID;
  return isInternalProductionOwner(user, { INTERNAL_PRODUCTION_OWNER_USER_ID: owner });
}

/** Worker-side refusal (before any reservation or payment): the account may not use Recraft, or a Long Form row's stored
 * choice does not match its confirmed plan. Customer-safe text; retrying cannot fix it (support reviews). */
export class RecraftAccessError extends Error {
  readonly customerMessage: string;
  constructor(readonly reason: "account" | "plan_mismatch" = "account") {
    const text = reason === "account"
      ? "Las imágenes IA con Recraft no están habilitadas para la cuenta de este video. No se inició la producción ni se cobró nada; soporte revisa la configuración."
      : "La elección de imágenes de este documental no coincide con su plan confirmado. No se inició la producción ni se cobró nada; soporte revisa el caso.";
    super(text);
    this.name = "RecraftAccessError";
    this.customerMessage = text;
  }
}
