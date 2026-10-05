import { getPlanByPriceId, PLAN_CONFIGS } from "@/lib/billing/plans";
import { isSubscriptionActive } from "@/lib/billing/subscription";

export type FinanceSubscription = { user_id: string; status: string; price_id: string | null; avatarLimit?: number; longFormAccess?: boolean };
export type FinanceRequest = { id: string; user_id: string; status: string; mode: string | null; created_at: string };
export type FinanceHold = { project_id: string; reserved_usd: number | string; consumed_usd: number | string };
export type ObligationRates = { reel: number | null; avatar: number | null; longForm: number | null };
export type ObligationOverview = {
  accounts: number; trials: number; unmappedPlans: number;
  remainingReels: number; remainingAvatars: number; processingJobs: number;
  futureUsd: number | null; processingUsd: number | null; reserveUsd: number | null;
  missingRates: string[]; monthStart: string;
};

function positive(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
/** Planning estimates only. Never infer tariffs, bank funds or wallets from defaults. */
export function obligationRates(env: Record<string, string | undefined> = process.env): ObligationRates {
  return { reel: positive(env.SUPPLY_RESERVE_REEL_USD), avatar: positive(env.SUPPLY_RESERVE_AVATAR_USD), longForm: positive(env.SUPPLY_RESERVE_LONG_FORM_USD) };
}
/** Same calendar-month boundary as the existing quota counter, including its runtime timezone. */
export function quotaMonthStart(now = new Date()): string {
  const start = new Date(now); start.setDate(1); start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

export function estimateObligations(input: {
  subscriptions: FinanceSubscription[]; requests: FinanceRequest[]; holds: FinanceHold[];
  rates: ObligationRates; monthStart: string; contingencyRatio?: number;
}): ObligationOverview {
  const { subscriptions, requests, holds, rates, monthStart } = input;
  const contingency = input.contingencyRatio ?? 0.3;
  if (!Number.isFinite(contingency) || contingency < 0 || contingency > 1) throw new Error("INVALID_RESERVE_MARGIN");
  const active = subscriptions.filter(s => isSubscriptionActive(s.status));
  const usage = new Map<string, { normal: number; avatar: number }>();
  const boundary = Date.parse(monthStart);
  if (!Number.isFinite(boundary)) throw new Error("INVALID_QUOTA_BOUNDARY");
  for (const r of requests) {
    const created = Date.parse(r.created_at);
    if (!Number.isFinite(created)) throw new Error("INVALID_FINANCE_DATE");
    if (!["completed", "processing"].includes(r.status) || created < boundary) continue;
    const count = usage.get(r.user_id) ?? { normal: 0, avatar: 0 };
    if (r.mode === "avatar") count.avatar++; else count.normal++;
    usage.set(r.user_id, count);
  }
  let remainingReels = 0, remainingAvatars = 0, unmappedPlans = 0, normalOnly = 0, longFormEligible = 0;
  for (const s of active) {
    const mapped = getPlanByPriceId(s.price_id);
    if (!mapped) unmappedPlans++;
    // Mirror admission's conservative fallback, but mark the financial estimate unverified.
    const plan = mapped ?? PLAN_CONFIGS.starter;
    const used = usage.get(s.user_id) ?? { normal: 0, avatar: 0 };
    const normal = Math.max(0, plan.monthlyNormalLimit - used.normal);
    remainingReels += normal;
    if (s.longFormAccess) longFormEligible += normal; else normalOnly += normal;
    remainingAvatars += Math.max(0, (s.avatarLimit ?? plan.monthlyAvatarLimit) - used.avatar);
  }
  const missing = new Set<string>();
  const cost = (quantity: number, rate: number | null, name: string) => {
    if (quantity === 0) return 0;
    if (rate === null || !Number.isFinite(rate) || rate <= 0) { missing.add(name); return null; }
    return quantity * rate;
  };
  const reelCost = cost(normalOnly, rates.reel, "reels"), avatarCost = cost(remainingAvatars, rates.avatar, "avatares");
  // An account with Long Form access can spend its normal quota on either mode.
  const longRate = rates.reel === null || rates.longForm === null ? null : Math.max(rates.reel, rates.longForm);
  const longCost = cost(longFormEligible, longRate, "videos largos");
  const futureUsd = reelCost === null || avatarCost === null || longCost === null || unmappedPlans > 0 ? null : reelCost + avatarCost + longCost;
  const held = new Map<string, number>();
  for (const h of holds) {
    const reserved = Number(h.reserved_usd), consumed = Number(h.consumed_usd);
    if (!Number.isFinite(reserved) || !Number.isFinite(consumed) || consumed < 0 || reserved < consumed) throw new Error("INVALID_FINANCE_HOLD");
    held.set(h.project_id, (held.get(h.project_id) ?? 0) + reserved - consumed);
  }
  let pending: number | null = 0;
  const processing = requests.filter(r => r.status === "processing");
  for (const r of processing) {
    const rate = r.mode === "avatar" ? rates.avatar : r.mode === "long_form" ? rates.longForm : rates.reel;
    // A full-job estimate is deliberately conservative: consumed work is not refunded.
    const estimated = cost(1, rate, r.mode === "avatar" ? "avatares" : r.mode === "long_form" ? "videos largos" : "reels");
    if (estimated === null) pending = null;
    else if (pending !== null) pending += Math.max(estimated, held.get(r.id) ?? 0);
    held.delete(r.id);
  }
  // Preserve open holds belonging to failed, old or otherwise unaccounted requests.
  if (pending !== null) pending += [...held.values()].reduce((a, b) => a + b, 0);
  const round = (n: number | null) => {
    if (n === null) return null;
    if (!Number.isFinite(n * 100) || n < 0) throw new Error("INVALID_FINANCE_TOTAL");
    return Math.max(0, Math.ceil(n * 100 - 1e-8) / 100);
  };
  return {
    accounts: active.length, trials: active.filter(s => s.status === "trialing").length, unmappedPlans,
    remainingReels, remainingAvatars, processingJobs: processing.length,
    futureUsd: round(futureUsd), processingUsd: round(pending),
    reserveUsd: round(futureUsd === null || pending === null ? null : (futureUsd + pending) * (1 + contingency)),
    missingRates: [...missing], monthStart,
  };
}
