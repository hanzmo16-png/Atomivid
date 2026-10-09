import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordMarketingEvent, type Attribution } from "./events";

export const EARLY_ACCESS_PRODUCTS = ["documentales"] as const;
export type EarlyAccessProduct = (typeof EARLY_ACCESS_PRODUCTS)[number];

export type EarlyAccessInput = { email: unknown; consent: unknown; website: unknown };
export type EarlyAccessResult = { ok: true; already: boolean } | { ok: false; error: string };

// Deliberately simple: one "@", a dot in the domain, no spaces. Delivery is confirmed by the person later.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pure validation, shared by the action and its tests. "website" is a honeypot real people never fill. */
export function validateEarlyAccess(input: EarlyAccessInput): { ok: true; email: string } | { ok: false; error: string; bot?: true } {
  if (typeof input.website === "string" && input.website.trim() !== "") return { ok: false, error: "No se pudo registrar la solicitud.", bot: true };
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL.test(email)) return { ok: false, error: "Escribe un correo válido." };
  if (input.consent !== "on") return { ok: false, error: "Marca la casilla para aceptar que te contactemos sobre el acceso anticipado." };
  return { ok: true, email };
}

/**
 * Stores one request per product and email (a repeat is acknowledged, not duplicated). Collects only the
 * email, the consent time, the account id when signed in, a random visitor id and the campaign source.
 */
export async function joinEarlyAccess(service: SupabaseClient, product: EarlyAccessProduct, input: EarlyAccessInput,
  ctx: { userId: string | null; visitorId: string | null; attribution: Attribution }): Promise<EarlyAccessResult> {
  const v = validateEarlyAccess(input);
  if (!v.ok) return v.bot ? { ok: true, already: false } : { ok: false, error: v.error };
  const { data: existing, error: readError } = await service.from("early_access_requests").select("id").eq("product", product).eq("email", v.email).maybeSingle();
  if (readError) return { ok: false, error: "No se pudo registrar la solicitud. Intenta de nuevo en un momento." };
  if (existing) return { ok: true, already: true };
  const { error } = await service.from("early_access_requests").upsert({
    product, email: v.email, user_id: ctx.userId, visitor_id: ctx.visitorId, source: ctx.attribution.source, consent_at: new Date().toISOString(),
  }, { onConflict: "product,email", ignoreDuplicates: true });
  if (error) return { ok: false, error: "No se pudo registrar la solicitud. Intenta de nuevo en un momento." };
  await recordMarketingEvent(service, { event: "early_access_joined", dedupeKey: `early_access_joined:${product}:${hashEmail(v.email)}`,
    userId: ctx.userId, visitorId: ctx.visitorId, attribution: ctx.attribution });
  return { ok: true, already: false };
}

/** The event table never stores the email: its dedupe key carries a one-way digest instead. */
function hashEmail(email: string): string {
  return createHash("sha256").update(`early-access:${email}`).digest("hex").slice(0, 32);
}
