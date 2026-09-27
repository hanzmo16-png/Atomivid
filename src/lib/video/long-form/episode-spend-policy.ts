/** Explicit cumulative ceilings. These limits do not grant permission to spend:
 * callers still require their paid flag, a requested budget and ledger reservation.
 * The ocean approval includes its existing stage-A expenditure and valued TTS.
 */
export function episodeSpendCeiling(
  requestId: string,
  ledgerPrefix: string,
  phase: "narration" | "assets",
): number {
  if (requestId === "ocean-deep-001" && ledgerPrefix === "ocean-deep-001/samples/episode") return 17.65;
  return phase === "narration" ? 15 : 10;
}

export function assertEpisodeBudget(
  budgetUsd: number,
  requestId: string,
  ledgerPrefix: string,
  phase: "narration" | "assets",
): void {
  const ceiling = episodeSpendCeiling(requestId, ledgerPrefix, phase);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > ceiling) {
    throw new Error(`Presupuesto acumulado inválido: debe ser 0 < USD ≤ ${ceiling}`);
  }
}
