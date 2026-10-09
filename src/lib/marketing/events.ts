import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * First-party funnel measurement (table public.marketing_events, server-only). Every emitter passes a
 * dedupe key, so a reload, a double click or a provider redelivery is counted once. Only a random visitor
 * id, the account id when known and the campaign source are stored — never an email, a script, a payment
 * detail or a credential. Recording never throws into the flow that emits it.
 */
export const MARKETING_EVENTS = ["landing_view", "cta_click", "early_access_joined", "signup_completed", "checkout_started", "payment_confirmed", "first_production_completed"] as const;
export type MarketingEvent = (typeof MARKETING_EVENTS)[number];

/** Calls to action that the public pages may report (anything else is ignored). */
export const MARKETING_CTAS = ["header_register", "header_login", "hero_register", "hero_pricing", "pricing_register", "early_access_open", "final_register", "header_waitlist", "hero_waitlist", "pricing_waitlist", "final_waitlist"] as const;
export type MarketingCta = (typeof MARKETING_CTAS)[number];

export const VISITOR_COOKIE = "atv_vid";
export const ATTRIBUTION_COOKIE = "atv_src";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type Attribution = { source: string | null; medium: string | null; campaign: string | null };

/** Campaign words only: letters, digits, '.', '_' and '-', at most 64 characters; anything else is dropped. */
export function cleanToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().slice(0, 64);
  return /^[a-z0-9._-]+$/.test(v) ? v : null;
}

export function validVisitorId(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

export function attributionFromSearch(search: URLSearchParams): Attribution {
  return { source: cleanToken(search.get("utm_source")), medium: cleanToken(search.get("utm_medium")), campaign: cleanToken(search.get("utm_campaign")) };
}

/** Stored as "source|medium|campaign" in a first-party cookie, read back by later server steps. */
export function encodeAttribution(a: Attribution): string {
  return [a.source ?? "", a.medium ?? "", a.campaign ?? ""].join("|");
}
export function decodeAttribution(value: string | undefined | null): Attribution {
  const [source, medium, campaign] = String(value ?? "").split("|");
  return { source: cleanToken(source), medium: cleanToken(medium), campaign: cleanToken(campaign) };
}

export const utcDay = (now: Date) => now.toISOString().slice(0, 10);

export type EventInput = {
  event: MarketingEvent;
  dedupeKey: string;
  visitorId?: string | null;
  userId?: string | null;
  cta?: MarketingCta | null;
  attribution?: Attribution;
};

/** Inserts once per dedupe key; failures are logged without detail and never thrown. */
export async function recordMarketingEvent(service: SupabaseClient, input: EventInput): Promise<boolean> {
  try {
    if (!MARKETING_EVENTS.includes(input.event) || !input.dedupeKey || input.dedupeKey.length > 200) return false;
    const a = input.attribution ?? { source: null, medium: null, campaign: null };
    const { error } = await service.from("marketing_events").upsert({
      event: input.event,
      dedupe_key: input.dedupeKey,
      visitor_id: validVisitorId(input.visitorId),
      user_id: input.userId ?? null,
      cta: input.cta && MARKETING_CTAS.includes(input.cta) ? input.cta : null,
      source: a.source, medium: a.medium, campaign: a.campaign,
    }, { onConflict: "dedupe_key", ignoreDuplicates: true });
    if (error) { console.error(`[atomivid:marketing] ${input.event} not recorded`); return false; }
    return true;
  } catch {
    console.error(`[atomivid:marketing] ${input.event} not recorded`);
    return false;
  }
}
