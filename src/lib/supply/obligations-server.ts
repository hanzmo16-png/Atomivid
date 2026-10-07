import type { SupabaseClient } from "@supabase/supabase-js";
import { getPlanByPriceId, PLAN_CONFIGS } from "@/lib/billing/plans";
import { resolveAvatarLimit } from "@/lib/billing/quota";
import { isLongFormEnabled, isLongFormAllowlisted } from "@/lib/video/long-form/access";
import { estimateObligations, obligationRates, quotaMonthStart, type FinanceSubscription, type FinanceRequest, type FinanceHold, type ObligationOverview } from "./obligations";

/** OWNER/ADMIN callers only. Paginate rather than silently truncating to the API row limit. */
export async function readObligationOverview(service: SupabaseClient, now = new Date()): Promise<ObligationOverview> {
  const monthStart = quotaMonthStart(now);
  async function read<T>(page: (start: number, end: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; offset < 100_000; offset += 500) {
      const { data, error } = await page(offset, offset + 499);
      if (error || !data) throw new Error("FINANCE_OVERVIEW_UNAVAILABLE");
      rows.push(...data);
      if (data.length < 500) return rows;
    }
    throw new Error("FINANCE_OVERVIEW_INCOMPLETE");
  }
  const [subscriptions, requests, holds] = await Promise.all([
    read<FinanceSubscription>((start, end) => service.from("subscriptions").select("user_id,status,price_id").in("status", ["active", "trialing"]).order("user_id").range(start, end)),
    read<FinanceRequest>((start, end) => service.from("video_requests").select("id,user_id,status,mode,created_at").or(`and(created_at.gte.${monthStart},status.in.(processing,completed)),status.eq.processing`).order("id").range(start, end)),
    read<FinanceHold>((start, end) => service.from("pi_supply_job_reservations").select("id,project_id,reserved_usd,consumed_usd").eq("status", "OPEN").order("id").range(start, end)),
  ]);
  // Private beta entitlements also cost money. Resolve identity on the server only,
  // with bounded concurrency; user identifiers and emails never reach the panel.
  if (process.env.AVATAR_PREPARATION_OWNER_EMAIL || isLongFormEnabled()) {
    for (let offset = 0; offset < subscriptions.length; offset += 8) {
      await Promise.all(subscriptions.slice(offset, offset + 8).map(async s => {
        const { data, error } = await service.auth.admin.getUserById(s.user_id);
        if (error || !data.user) throw new Error("FINANCE_PRIVATE_ACCESS_UNVERIFIED");
        s.avatarLimit = resolveAvatarLimit(getPlanByPriceId(s.price_id) ?? PLAN_CONFIGS.starter, data.user);
        s.longFormAccess = isLongFormEnabled() && isLongFormAllowlisted(data.user);
      }));
    }
  }
  return estimateObligations({ subscriptions, requests, holds, rates: obligationRates(), monthStart });
}
