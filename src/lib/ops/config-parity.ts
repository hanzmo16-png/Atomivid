/**
 * Settings that size a production's supply reservation. They are computed at START in Vercel (render
 * route reserves the envelope) and AGAIN in the worker (GitHub Actions re-reserves the same attempt and
 * sizes each paid call). Any difference makes the worker ask for more than was reserved ("job envelope
 * changed"/"exhausted") — the avatar 6dad04ec failure. Values only, never secrets.
 */
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { getPricingConfig } from "@/lib/billing/pricing";

export type ReservationConfig = Record<string, string | number | boolean>;

/** Effective values in THIS process (read from process.env at call time). */
export function reservationConfig(): ReservationConfig {
  const f = getFeatureFlags();
  return {
    elevenLabsUsdPer1kChars: getPricingConfig().elevenLabsUsdPer1kChars,
    avatarProvider: f.avatarProvider, maxAvatarCostUsd: f.maxAvatarCostUsd, maxAvatarDurationSeconds: f.maxAvatarDurationSeconds,
    imageGenerationEnabled: f.imageGenerationEnabled, imageProvider: f.imageProvider, maxVisualCostUsd: f.maxVisualCostUsd,
    visualDirectorEnabled: f.visualDirectorEnabled, storyboardReservationUsd: Number(process.env.SUPPLY_STORYBOARD_RESERVATION_USD || "2"),
    premiumClipsEnabled: f.premiumClipsEnabled, videoProvider: f.videoProvider, maxPremiumVideoCostUsd: f.maxPremiumVideoCostUsd,
    musicProvider: String((f as { musicProvider?: unknown }).musicProvider ?? ""), maxMusicCostUsd: f.maxMusicCostUsd,
  };
}

/** Field-by-field comparison; only differences are returned. */
export function configDiff(a: ReservationConfig, b: ReservationConfig): { field: string; vercel: unknown; worker: unknown }[] {
  return Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]).map((k) => ({ field: k, vercel: a[k], worker: b[k] }));
}

/** Literal (non-secret) env values a workflow step sets, e.g. MAX_AVATAR_COST_USD: '2'. Expressions/secrets are reported as opaque. */
export function workflowLiteralEnv(yml: string, stepMarker: string): { literals: Record<string, string>; opaque: string[] } {
  const start = yml.indexOf(stepMarker);
  const block = start >= 0 ? yml.slice(start) : "";
  const envStart = block.indexOf("env:");
  const lines = envStart >= 0 ? block.slice(envStart + 4).split("\n") : [];
  const literals: Record<string, string> = {}, opaque: string[] = [];
  for (const line of lines) {
    if (/^\s*-\s+name:/.test(line)) break;
    const m = line.match(/^\s+([A-Z][A-Z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const v = m[2].trim();
    if (v.startsWith("${{")) opaque.push(m[1]);
    else literals[m[1]] = v.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
  }
  return { literals, opaque };
}
