/** Time windows for Command Center aggregation. All bounds are ISO UTC; LIFETIME has no lower bound. */
export const WINDOWS = ["TODAY", "7D", "28D", "MTD", "LIFETIME"] as const;
export type WindowKey = (typeof WINDOWS)[number];
export type TimeRange = { window: WindowKey; fromIso: string | null; toIso: string };

export function timeRange(window: WindowKey, now: string): TimeRange {
  const t = new Date(now);
  const dayStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  const from = window === "TODAY" ? dayStart : window === "7D" ? new Date(t.getTime() - 7 * 86400_000) : window === "28D" ? new Date(t.getTime() - 28 * 86400_000) : window === "MTD" ? new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)) : null;
  return { window, fromIso: from ? from.toISOString() : null, toIso: t.toISOString() };
}

export const inRange = (iso: string | null | undefined, r: TimeRange) => !!iso && (r.fromIso === null || iso >= r.fromIso) && iso <= r.toIso;
export const isWindowKey = (v: unknown): v is WindowKey => typeof v === "string" && (WINDOWS as readonly string[]).includes(v);
