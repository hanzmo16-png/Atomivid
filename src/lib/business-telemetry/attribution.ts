/**
 * Business Telemetry V0 — attribution foundation. Captures ONLY allowlisted UTM parameters,
 * two click identifiers and the landing path, as append-only touches per anonymous visitor
 * (later linked to a user through user_registered.visitor_id). First touch and last touch are
 * resolved by reading touches in order — no multi-touch model, no acquisition-cost metrics, no ad platform.
 * Client-supplied parameters are evidence about a visit, never financial facts.
 */
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { looksSecret } from "./sanitize";

export const UTM_ALLOWLIST = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
export const CLICK_ID_ALLOWLIST = ["gclid", "fbclid"] as const;
export type UtmKey = (typeof UTM_ALLOWLIST)[number];
export type ClickIdKey = (typeof CLICK_ID_ALLOWLIST)[number];
const MAX_VALUE = 200;
const VALUE_SHAPE = /^[A-Za-z0-9 _.%+\-:/()|]{1,200}$/;

export type AttributionTouch = {
  touchId: string;
  visitorId: string;
  userId: string | null;
  touchedAt: string;
  landingPage: string | null;
  utm: Partial<Record<UtmKey, string>>;
  clickIds: Partial<Record<ClickIdKey, string>>;
  source: string;
  provenance: "observed_live";
};

export type CaptureInput = { params: URLSearchParams | Record<string, string | undefined>; landingPage?: string | null; visitorId: string; userId?: string | null; touchedAt: string; source: string };
export type CaptureResult = { ok: true; touch: AttributionTouch; ignoredKeys: string[] } | { ok: false; reason: "no_attribution_data" | "invalid_value" | "invalid_visitor" | "invalid_landing_page"; detail: string };

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Only the path of the landing page is kept (never query strings or fragments, which could carry tokens). */
export function landingPath(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const u = input.startsWith("/") ? new URL(input, "https://placeholder.invalid") : new URL(input);
    return u.pathname.slice(0, 300) || "/";
  } catch { return null; }
}

export function captureAttribution(i: CaptureInput): CaptureResult {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(i.visitorId)) return { ok: false, reason: "invalid_visitor", detail: "visitor_id must be an opaque 8..128 char id" };
  const get = (k: string) => (i.params instanceof URLSearchParams ? i.params.get(k) : i.params[k]) ?? null;
  const allKeys = i.params instanceof URLSearchParams ? [...new Set(i.params.keys())] : Object.keys(i.params);
  const utm: Partial<Record<UtmKey, string>> = {};
  const clickIds: Partial<Record<ClickIdKey, string>> = {};
  const check = (k: string, v: string): string | null => {
    const t = v.trim();
    if (!t) return null;
    if (t.length > MAX_VALUE || !VALUE_SHAPE.test(t) || t.includes("@") || looksSecret(t)) throw new Error(`${k}: value refused (shape, length, e-mail or secret-like)`);
    return t;
  };
  try {
    for (const k of UTM_ALLOWLIST) { const v = get(k); if (v !== null) { const c = check(k, v); if (c) utm[k] = c; } }
    for (const k of CLICK_ID_ALLOWLIST) { const v = get(k); if (v !== null) { const c = v.trim(); if (c && (c.length > MAX_VALUE || !/^[A-Za-z0-9_.-]+$/.test(c))) throw new Error(`${k}: malformed click id`); if (c) clickIds[k] = c; } }
  } catch (e) { return { ok: false, reason: "invalid_value", detail: e instanceof Error ? e.message : String(e) }; }
  const landing = landingPath(i.landingPage);
  if (i.landingPage && !landing) return { ok: false, reason: "invalid_landing_page", detail: "landing page must be a URL or path" };
  const ignoredKeys = allKeys.filter((k) => !(UTM_ALLOWLIST as readonly string[]).includes(k) && !(CLICK_ID_ALLOWLIST as readonly string[]).includes(k)).sort();
  if (Object.keys(utm).length === 0 && Object.keys(clickIds).length === 0 && !landing) return { ok: false, reason: "no_attribution_data", detail: "no allowlisted parameter and no landing page" };
  const touchedAt = new Date(i.touchedAt).toISOString();
  const touchId = "att_" + sha(JSON.stringify({ v: i.visitorId, t: touchedAt, utm, clickIds, landing })).slice(0, 32);
  return { ok: true, touch: { touchId, visitorId: i.visitorId, userId: i.userId ?? null, touchedAt, landingPage: landing, utm, clickIds, source: i.source, provenance: "observed_live" }, ignoredKeys };
}

/** FIRST touch = earliest recorded touch, LAST touch = latest. Ties break on touch id so the answer is deterministic. */
export function resolveTouches(touches: AttributionTouch[]): { firstTouch: AttributionTouch; lastTouch: AttributionTouch; touches: number } | null {
  if (!touches.length) return null;
  const sorted = [...touches].sort((a, b) => a.touchedAt.localeCompare(b.touchedAt) || a.touchId.localeCompare(b.touchId));
  return { firstTouch: sorted[0], lastTouch: sorted[sorted.length - 1], touches: sorted.length };
}

export interface AttributionStore {
  append(t: AttributionTouch): Promise<{ inserted: boolean }>;
  forVisitor(visitorId: string): Promise<AttributionTouch[]>;
}
export class MemoryAttributionStore implements AttributionStore {
  readonly touches = new Map<string, AttributionTouch>();
  async append(t: AttributionTouch) { if (this.touches.has(t.touchId)) return { inserted: false }; this.touches.set(t.touchId, structuredClone(t)); return { inserted: true }; }
  async forVisitor(v: string) { return [...this.touches.values()].filter((t) => t.visitorId === v); }
}
export function supabaseAttributionStore(sb: SupabaseClient): AttributionStore {
  const row = (t: AttributionTouch) => ({ touch_id: t.touchId, visitor_id: t.visitorId, user_id: t.userId, touched_at: t.touchedAt, landing_page: t.landingPage, utm_source: t.utm.utm_source ?? null, utm_medium: t.utm.utm_medium ?? null, utm_campaign: t.utm.utm_campaign ?? null, utm_content: t.utm.utm_content ?? null, utm_term: t.utm.utm_term ?? null, gclid: t.clickIds.gclid ?? null, fbclid: t.clickIds.fbclid ?? null, source: t.source, provenance: t.provenance });
  const back = (d: Record<string, unknown>): AttributionTouch => {
    const utm: Partial<Record<UtmKey, string>> = {}; for (const k of UTM_ALLOWLIST) if (d[k]) utm[k] = String(d[k]);
    const clickIds: Partial<Record<ClickIdKey, string>> = {}; for (const k of CLICK_ID_ALLOWLIST) if (d[k]) clickIds[k] = String(d[k]);
    return { touchId: String(d.touch_id), visitorId: String(d.visitor_id), userId: d.user_id ? String(d.user_id) : null, touchedAt: new Date(String(d.touched_at)).toISOString(), landingPage: d.landing_page ? String(d.landing_page) : null, utm, clickIds, source: String(d.source), provenance: "observed_live" };
  };
  return {
    async append(t) { const { error } = await sb.from("business_attribution_touches").insert(row(t)); if (!error) return { inserted: true }; if (error.code === "23505") return { inserted: false }; throw new Error(`attribution insert failed: ${error.message}`); },
    async forVisitor(v) { const { data, error } = await sb.from("business_attribution_touches").select("*").eq("visitor_id", v).order("touched_at", { ascending: true }).limit(500); if (error) throw new Error(`attribution read failed: ${error.message}`); return ((data ?? []) as Record<string, unknown>[]).map(back); },
  };
}
