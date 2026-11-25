/** The application's all-stage ceiling already includes the settled script.
 * Reserve only its uncommitted remainder, but never infer or forgive a payment.
 */
export function incrementalRenderReserve(total: number, displayedScript: number | null, settledScript: number | null): number | null {
  if (![total, displayedScript, settledScript].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)) return null;
  if (Math.abs(displayedScript! - settledScript!) > 0.000001 || total < settledScript!) return null;
  return Math.ceil((total - settledScript! - Number.EPSILON) * 100) / 100;
}
import type { LedgerState } from "../../src/lib/mystery-shopper/v3/ledger";

export function verifiedReusableScript(state: LedgerState | null, key: string): number | null {
  if (!state || !/^ms-[a-z0-9-]+-yt-script$/.test(key)) return null;
  const rs = state.reservations.filter(r => r.key === key);
  const ss = state.settlements.filter(s => s.key === key);
  if (rs.length !== 1 || ss.length !== 1 || rs[0].module !== "youtube") return null;
  const spent = ss[0].spentUsd;
  if (!Number.isFinite(spent) || spent < 0 || !Number.isFinite(rs[0].reservedUsd) || spent > rs[0].reservedUsd) return null;
  return spent;
}

