import { totals, type LedgerState } from "../../src/lib/mystery-shopper/v3/ledger";
export const TECHNICAL_POLICY = { youtube: 4, "audio-podcast": 1, reels: 0.5, "video-podcast": 3 } as const;
const cents = (amount: number) => Number.isFinite(amount) && Number.isSafeInteger(Math.round(amount * 100)) && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-7;
export function allocationRefusal(receipt: any, binding: { requestId: string; reviewSha256: string; ownerId: string; now: number }): string | null {
  if (!receipt || receipt.scope !== "OWNER_APPROVED_ONE_TECHNICAL_LONG_FORM_RUN" || receipt.approved !== true || receipt.requestId !== binding.requestId || receipt.reviewSha256 !== binding.reviewSha256 || receipt.ownerId !== binding.ownerId || typeof receipt.ownerReplyRef !== "string" || !receipt.ownerReplyRef.trim() || !/^[0-9a-f]{64}$/.test(receipt.ownerReplySha256 ?? "") || !/^[0-9a-f]{64}$/.test(receipt.ledgerBaselineSha256 ?? "")) return "explicit bound owner allocation missing";
  if (!Number.isFinite(Date.parse(receipt.approvedAt)) || Date.parse(receipt.approvedAt) > binding.now || !Number.isFinite(Date.parse(receipt.expiresAt)) || Date.parse(receipt.expiresAt) <= binding.now) return "allocation absent or expired";
  if (receipt.maxNewUsd !== 2 || receipt.totalCapUsd !== 8.5 || receipt.reservedAvUsd !== 3 || JSON.stringify(Object.entries(receipt.moduleCaps ?? {}).sort()) !== JSON.stringify(Object.entries(TECHNICAL_POLICY).sort())) return "allocation policy mismatch";
  return null;
}
export function validateStrictLedger(state: LedgerState): void {
  const reservations = new Map<string, any>(), settlements = new Set<string>();
  for (const r of state.reservations) {
    if (!r || typeof r.key !== "string" || !/^[a-zA-Z0-9-]{1,160}$/.test(r.key) || reservations.has(r.key) || !Object.hasOwn(TECHNICAL_POLICY, r.module) || typeof r.jobId !== "string" || !r.jobId || !cents(r.reservedUsd) || r.reservedUsd <= 0 || !Number.isFinite(Date.parse(r.at))) throw Error("malformed or duplicate ledger reservation");
    reservations.set(r.key, r);
  }
  for (const s of state.settlements) {
    if (!s || !reservations.has(s.key) || settlements.has(s.key) || !cents(s.spentUsd) || s.spentUsd < 0 || s.spentUsd > reservations.get(s.key).reservedUsd || !Number.isFinite(Date.parse(s.at)) || typeof s.source !== "string" || !s.source) throw Error("malformed duplicate orphan or over-reservation ledger settlement");
    settlements.add(s.key);
  }
}
export function technicalReserveRefusal(state: LedgerState, key: string, quote: number): string | null {
  try { validateStrictLedger(state); } catch { return "ledger unverifiable"; }
  if (!cents(quote) || quote <= 0 || quote > 2) return "new total quote exceeds two dollars or is unverifiable";
  if (state.reservations.some(r => r.key === key) || state.settlements.some(s => s.key === key)) return "one-shot reservation already exists";
  const t = totals(state);
  if (t.openReservedUsd !== 0) return "historical open reservations require reconciliation before a new run";
  for (const [module, cap] of Object.entries(TECHNICAL_POLICY)) if ((t.byModule[module] ?? 0) + (module === "youtube" ? quote : 0) > cap + 1e-9) return "allocated module exposure exceeded";
  // AV owns its entire three dollars, even before its future reservation appears in the ledger.
  if (t.committedUsd + quote + Math.max(0, 3 - (t.byModule["video-podcast"] ?? 0)) > 8.5 + 1e-9) return "aggregate exposure including reserved AV exceeds 8.50";
  return null;
}
export async function readTechnicalLedger(bucket: any): Promise<LedgerState> {
  const listed = await bucket.list("mystery-shopper/v3/ledger", { limit: 1000 });
  if (listed.error || !Array.isArray(listed.data) || listed.data.length >= 1000 || listed.data.some((x: any) => x.name === "STOP")) throw Error("ledger unavailable or STOP");
  const state: LedgerState = { reservations: [], settlements: [] };
  for (const item of listed.data.sort((a: any, b: any) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const match = /^(reserve|settle)-([a-zA-Z0-9-]{1,160})\.json$/.exec(item.name);
    if (!match) throw Error("unknown ledger object");
    const downloaded = await bucket.download(`mystery-shopper/v3/ledger/${item.name}`);
    if (downloaded.error || !downloaded.data) throw Error("ledger object unreadable");
    const row = JSON.parse(await downloaded.data.text());
    if (row.key !== match[2]) throw Error("ledger identity mismatch");
    (match[1] === "reserve" ? state.reservations : state.settlements).push(row);
  }
  validateStrictLedger(state);
  return state;
}
