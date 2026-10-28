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

/**
 * Worker-side decision. The render worker only gets the owner id through RECRAFT_PILOT_OWNER_USER_ID, which is empty
 * when the Actions secret is not configured: the web would offer Recraft to the owner and the worker would then refuse
 * it (real Long Form run, 2026-10-27). With no pilot owner configured in the worker, it asks the app (signed request,
 * yes/no answer) with the same criterion the web used. The general flag and a configured owner id behave as before.
 */
export async function recraftAllowedForWorker(user: InternalProductionUser, env: Record<string, string | undefined> = process.env,
  askApp?: (userId: string) => Promise<boolean>): Promise<boolean> {
  if (recraftAllowedFor(user, env)) return true;
  if (env.RECRAFT_PILOT_OWNER_USER_ID?.trim() || env.INTERNAL_PRODUCTION_OWNER_USER_ID?.trim()) return false;
  if (!user?.id || !user.email_confirmed_at) return false;
  const ask = askApp ?? (async (id: string) => (await import("@/lib/podcast/v3/owner-check")).askAppIsInternalOwner(id, env));
  return ask(user.id).catch(() => false);
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
