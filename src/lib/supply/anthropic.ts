import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServiceClient } from "@/lib/supabase/service";
import { getPricingConfig } from "@/lib/billing/pricing";
import { guardPaidCall } from "@/lib/paid-calls/gate";
import { supabaseLedgerStore } from "@/lib/paid-calls/supabase-ledger-store";
import { supabaseResultStore, paidResultPath } from "@/lib/paid-calls/result-store";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { supplyGuardRequired } from "./server";

const context = new AsyncLocalStorage<{ projectId: string; intentId: string }>();
export function withSupplyContext<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  return context.run({ projectId, intentId: randomUUID() }, fn);
}
/** Every SDK call/correction has its own upper-bound reservation. SDK retries MUST be zero.
 * Interrupted/uncertain submissions stay in the existing ledger; this helper never retries. */
export async function supplyProtectedAnthropic<T extends { usage?: { input_tokens: number; output_tokens: number } }>(
  params: { model: string; max_tokens: number } & Record<string, unknown>, invoke: () => Promise<T>,
): Promise<T> {
  if (!supplyGuardRequired()) return invoke();
  const pricing = getPricingConfig();
  const inputUpper = Buffer.byteLength(JSON.stringify(params)) + 8192;
  const upperUsd = (inputUpper * pricing.scriptInputUsdPer1MTokens + params.max_tokens * pricing.scriptOutputUsdPer1MTokens) / 1e6;
  if (!(upperUsd > 0) || !Number.isFinite(upperUsd)) throw new Error("SCRIPT_SUPPLY_COST_UNVERIFIED");
  const scope = context.getStore() ?? { projectId: "operator-script", intentId: randomUUID() };
  const service = createServiceClient(), results = supabaseResultStore(service);
  const paid = await guardPaidCall<T>(supabaseLedgerStore(service), {
    projectId: scope.projectId, shotId: `script:${scope.intentId}:${stableHash(params, 16)}`,
    provider: "anthropic", model: params.model, method: "generate_script",
    inputFingerprint: params, reservedUsd: upperUsd,
  }, { async call({ key }) {
    const result = await invoke();
    const usage = result.usage;
    const costUsd = usage ? (usage.input_tokens * pricing.scriptInputUsdPer1MTokens + usage.output_tokens * pricing.scriptOutputUsdPer1MTokens) / 1e6 : upperUsd;
    const resultRef = paidResultPath(scope.projectId, key, "script.json");
    await results.putJson(resultRef, result);
    return { result, costUsd, resultRef };
  }, load: ref => results.getJson<T>(ref), maxRejectedRetries: 0 });
  return paid.result;
}
