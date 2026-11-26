/** Shared quote/dispatch/admission policy. Unknown duration retains the legacy maximum. */
export function longFormRenderTimeout(durationSeconds?: number | null): { jobMinutes: number; stepMinutes: number } {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 1800) return { jobMinutes: 330, stepMinutes: 300 };
  if (durationSeconds <= 300) return { jobMinutes: 45, stepMinutes: 30 };
  if (durationSeconds <= 600) return { jobMinutes: 90, stepMinutes: 75 };
  if (durationSeconds <= 1200) return { jobMinutes: 180, stepMinutes: 165 };
  return { jobMinutes: 330, stepMinutes: 300 };
}
/** Real GHA worker must carry the same ceiling quoted for the stored request, never an arbitrary larger timeout. */
export function longFormTimeoutMatches(durationSeconds: number, declaredJob: string | undefined): boolean {
  return declaredJob === String(longFormRenderTimeout(durationSeconds).jobMinutes);
}
