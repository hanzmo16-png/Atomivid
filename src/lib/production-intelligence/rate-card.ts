/**
 * Versioned rate cards. Cost Engine input only: it sums, it never judges aesthetics.
 * Prices mirror the constants the provider adapters already charge with
 * (runway.ts RUNWAY_COST_USD_PER_SECOND, openai.ts token rates, DULCE ledger);
 * a test keeps them in sync so the card cannot silently drift from real adapters.
 */
import type { Method } from "./ladder";

export type RateUnit = "second" | "image" | "character";

export type RateEntry = {
  provider: "runway" | "veo" | "openai" | "elevenlabs" | "stock" | "internal";
  model: string;
  /** Provider model version when the provider exposes one; never invented. */
  modelVersion: string | "unknown";
  unit: RateUnit;
  /** Expected price per unit (USD). */
  price: number;
  /** Upper bound per unit used for worst-case reservation (USD). */
  worstPrice: number;
  source: string;
};

export type RateCard = {
  rateCardVersion: string;
  effectiveFrom: string;
  entries: Record<string, RateEntry>;
  /** Billed clip length requested from the provider per generative method. */
  clipSeconds: Partial<Record<Method, number>>;
  /** Which entry prices each paid method (still image + motion). */
  methodEntries: Partial<Record<Method, { still?: string; motion?: string }>>;
};

export const RATE_CARD_V1: RateCard = {
  rateCardVersion: "rate-card/2026-09-28.1",
  effectiveFrom: "2026-09-28",
  entries: {
    "runway:gen4_turbo": { provider: "runway", model: "gen4_turbo", modelVersion: "unknown", unit: "second", price: 0.05, worstPrice: 0.05, source: "src/lib/providers/video-gen/runway.ts RUNWAY_COST_USD_PER_SECOND (5 credits/s, USD 0.01/credit)" },
    "veo:veo-3": { provider: "veo", model: "veo-3", modelVersion: "unknown", unit: "second", price: 0.12, worstPrice: 0.12, source: "src/lib/providers/video-gen/veo.ts VEO_DEFAULT_COST_USD_PER_SECOND" },
    "openai:gpt-image": { provider: "openai", model: "gpt-image", modelVersion: "unknown", unit: "image", price: 0.08, worstPrice: 0.3, source: "DULCE Part I ledger: 53 images USD 3.79 (mean 0.071); reservation cap IMAGE_MAX 0.30" },
    "elevenlabs:eleven_multilingual_v2": { provider: "elevenlabs", model: "eleven_multilingual_v2", modelVersion: "unknown", unit: "character", price: 0.0002, worstPrice: 0.0002, source: "top-up rate USD 5 / 25,000 characters (DULCE Part I)" },
    "stock:pexels": { provider: "stock", model: "pexels", modelVersion: "n/a", unit: "second", price: 0, worstPrice: 0, source: "free licensed stock" },
    "internal:camera": { provider: "internal", model: "ffmpeg-camera-move", modelVersion: "n/a", unit: "second", price: 0, worstPrice: 0, source: "local render, no API" },
  },
  clipSeconds: { I2V_ECONOMY: 5, I2V_HERO: 10 },
  methodEntries: {
    AI_STILL: { still: "openai:gpt-image" },
    STILL_KEN_BURNS: { still: "openai:gpt-image", motion: "internal:camera" },
    STILL_PARALLAX: { still: "openai:gpt-image", motion: "internal:camera" },
    I2V_ECONOMY: { still: "openai:gpt-image", motion: "runway:gen4_turbo" },
    I2V_HERO: { still: "openai:gpt-image", motion: "runway:gen4_turbo" },
    STOCK: { motion: "stock:pexels" },
  },
};

export const RATE_CARDS: Record<string, RateCard> = { [RATE_CARD_V1.rateCardVersion]: RATE_CARD_V1 };

export function providersFor(card: RateCard, m: Method): string[] {
  const e = card.methodEntries[m];
  if (!e) return [];
  return [e.still, e.motion].filter((x): x is string => !!x).map((k) => card.entries[k].provider).filter((p) => p !== "internal");
}
