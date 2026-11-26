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

/** A previously accounted all-attempt ceiling may fund only the same resumed request, attested by the private runner. */
export function verifiedExistingRenderFunding(state: LedgerState | null, key: string, needed: number): boolean {
 if(!state||!/^ms-[a-z0-9-]+-yt-render$/.test(key)||!Number.isFinite(needed)||needed<=0)return false;
 const r=state.reservations.filter(x=>x.key===key),s=state.settlements.filter(x=>x.key===key);
 return r.length===1&&s.length===1&&r[0].module==='youtube'&&key===`${r[0].jobId}-yt-render`&&Number.isFinite(r[0].reservedUsd)&&Number.isFinite(s[0].spentUsd)&&s[0].spentUsd===r[0].reservedUsd&&needed<=s[0].spentUsd;
}
