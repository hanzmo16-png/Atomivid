import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/service";
import {
  ATTRIBUTION_COOKIE, MARKETING_CTAS, VISITOR_COOKIE, attributionFromSearch, decodeAttribution, encodeAttribution,
  recordMarketingEvent, utcDay, validVisitorId, type MarketingCta,
} from "@/lib/marketing/events";

export const runtime = "nodejs";

const COOKIE = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 180 };

/**
 * Public page signals: a landing view and a click on a known call to action. Same-site requests only;
 * one count per visitor, event (and CTA) and UTC day. Always answers 204 so the page never waits on it.
 */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || new URL(origin).host !== new URL(request.url).host) return new Response(null, { status: 204 });
  let body: { event?: unknown; cta?: unknown; search?: unknown } = {};
  try { body = await request.json(); } catch { return new Response(null, { status: 204 }); }
  const event = body.event === "landing_view" || body.event === "cta_click" ? body.event : null;
  const cta = typeof body.cta === "string" && (MARKETING_CTAS as readonly string[]).includes(body.cta) ? (body.cta as MarketingCta) : null;
  if (!event || (event === "cta_click" && !cta)) return new Response(null, { status: 204 });

  const store = await cookies();
  let visitorId = validVisitorId(store.get(VISITOR_COOKIE)?.value);
  if (!visitorId) { visitorId = randomUUID(); store.set(VISITOR_COOKIE, visitorId, COOKIE); }
  // First touch wins: the campaign that brought the visitor is kept for the later sign-up and checkout.
  let attribution = decodeAttribution(store.get(ATTRIBUTION_COOKIE)?.value);
  if (event === "landing_view" && typeof body.search === "string" && !store.get(ATTRIBUTION_COOKIE)) {
    const fresh = attributionFromSearch(new URLSearchParams(body.search.slice(0, 500)));
    if (fresh.source || fresh.medium || fresh.campaign) { attribution = fresh; store.set(ATTRIBUTION_COOKIE, encodeAttribution(fresh), COOKIE); }
  }
  const day = utcDay(new Date());
  await recordMarketingEvent(createServiceClient(), {
    event, cta, visitorId, attribution,
    dedupeKey: event === "landing_view" ? `landing_view:${visitorId}:${day}` : `cta_click:${cta}:${visitorId}:${day}`,
  });
  return new Response(null, { status: 204 });
}
