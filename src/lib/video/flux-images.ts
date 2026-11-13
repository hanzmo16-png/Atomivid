import { isInternalProductionOwner, type InternalProductionUser } from "@/lib/billing/internal-production";
import { FLUX_USD_PER_MEGAPIXEL } from "@/lib/providers/image/flux";
import type { GeneratedScript } from "@/lib/providers/types";

/**
 * «Imágenes IA con FLUX» — the SECOND selectable image provider (FLUX.1 [dev] via fal.ai). Recraft stays the first
 * (default) choice; OpenAI Images keeps its existing role only under the existing rules. Pure (no I/O).
 *
 * A video chooses its image source once: `reel_image_source` = 'flux' (Reel at creation; Long Form in the same update
 * that confirms the plan, which also pins `providers.image = "flux"`). FLUX has no per-video style: every image is
 * generated from the scene prompt only. Any failure stops the video with a clear message; never a substitute.
 */
export type VideoImageSource = "default" | "recraft" | "flux";

/** Published price of ONE FLUX image as ATOMIVID requests it (≤ 1 MP, billed as 1 MP). */
export const FLUX_USD_PER_IMAGE = FLUX_USD_PER_MEGAPIXEL;

/** The source the browser sent, normalized. Unknown values are refused (never silently "default"). */
export function parseImageSource(raw: unknown): VideoImageSource | { error: string } {
  const v = String(raw ?? "default").trim() || "default";
  return v === "default" || v === "recraft" || v === "flux" ? v : { error: "Fuente de imágenes no válida." };
}

/**
 * Who may choose FLUX (Reel and Long Form). Server-only, from the authenticated user (never the browser):
 * - everyone, only when FLUX_IMAGES_ENABLED=true (general release; off by default);
 * - otherwise only the confirmed internal owner account (the same pilot criterion as Recraft).
 * Choosing FLUX never funds it: the `flux` supply policy, balance, per-request budget and spend caps still apply.
 */
export function fluxAllowedFor(user: InternalProductionUser, env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.FLUX_IMAGES_ENABLED?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  const owner = env.RECRAFT_PILOT_OWNER_USER_ID?.trim() || env.INTERNAL_PRODUCTION_OWNER_USER_ID;
  return isInternalProductionOwner(user, { INTERNAL_PRODUCTION_OWNER_USER_ID: owner });
}

/** Worker-side decision, same fallback as Recraft: with no owner id configured in the worker, ask the app (yes/no). */
export async function fluxAllowedForWorker(user: InternalProductionUser, env: Record<string, string | undefined> = process.env,
  askApp?: (userId: string) => Promise<boolean>): Promise<boolean> {
  if (fluxAllowedFor(user, env)) return true;
  if (env.RECRAFT_PILOT_OWNER_USER_ID?.trim() || env.INTERNAL_PRODUCTION_OWNER_USER_ID?.trim()) return false;
  if (!user?.id || !user.email_confirmed_at) return false;
  const ask = askApp ?? (async (id: string) => (await import("@/lib/podcast/v3/owner-check")).askAppIsInternalOwner(id, env));
  return ask(user.id).catch(() => false);
}

/** Worker-side refusal before any reservation or payment. Customer-safe; retrying cannot fix it (support reviews). */
export class FluxAccessError extends Error {
  readonly customerMessage: string;
  constructor(readonly reason: "account" | "plan_mismatch" = "account") {
    const text = reason === "account"
      ? "Las imágenes IA con FLUX no están habilitadas para la cuenta de este video. No se inició la producción ni se cobró nada; soporte revisa la configuración."
      : "La elección de imágenes de este documental no coincide con su plan confirmado. No se inició la producción ni se cobró nada; soporte revisa el caso.";
    super(text);
    this.name = "FluxAccessError";
    this.customerMessage = text;
  }
}

/** USD envelope for the FLUX images of one Reel attempt: one per scene + one regeneration per ~10 scenes (ceiling). */
export function fluxReelDemandUsd(script: unknown): number {
  const n = (script as GeneratedScript | null)?.segments?.length ?? 0;
  if (n === 0) return 0;
  const reserve = Math.max(1, Math.ceil(n * 0.1));
  return Math.round((n + reserve) * FLUX_USD_PER_IMAGE * 10_000) / 10_000;
}
