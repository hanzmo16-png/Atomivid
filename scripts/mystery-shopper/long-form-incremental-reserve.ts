/** The application's all-stage ceiling already includes the settled script.
 * Reserve only its uncommitted remainder, but never infer or forgive a payment.
 */
export function incrementalRenderReserve(total: number, displayedScript: number | null, settledScript: number | null): number | null {
  if (![total, displayedScript, settledScript].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)) return null;
  if (Math.abs(displayedScript! - settledScript!) > 0.000001 || total < settledScript!) return null;
  return Math.ceil((total - settledScript! - Number.EPSILON) * 100) / 100;
}
