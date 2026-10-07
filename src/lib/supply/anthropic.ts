import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServiceClient } from "@/lib/supabase/service";
import { getPricingConfig } from "@/lib/billing/pricing";
import { guardPaidCall, paidCallKey, type LedgerStore, type PaidCallSpec } from "@/lib/paid-calls/gate";
import { supabaseLedgerStore } from "@/lib/paid-calls/supabase-ledger-store";
import { supabaseResultStore, paidResultPath } from "@/lib/paid-calls/result-store";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { supplyGuardRequired } from "./server";
import { anthropicReservation, anthropicActualCost, type ScriptUsage } from "./anthropic-cost";
import { classifyAnthropicError } from "./anthropic-error";

import { admitDocumentaryCall } from "./documentary-step";

const context = new AsyncLocalStorage<{ projectId: string; intentId: string; recoverLegacyOperator?: boolean; uncertainResubmits?: number }>();
export function withSupplyContext<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  return context.run({ projectId, intentId: randomUUID() }, fn);
}
/** A failed documentary form resumes the same paid work, scoped to its authenticated owner. */
export function withDocumentarySupplyContext<T>(ownerId: string, input: unknown, recoverLegacyOperator: boolean, fn: () => Promise<T>, uncertainResubmits = 0): Promise<T> {
  return context.run({ ...documentarySupplyScope(ownerId, input, recoverLegacyOperator), uncertainResubmits }, fn);
}
/** A request whose outcome never reached us (worker killed mid-call) blocks its
 * key forever. Only an explicit owner resume grants a bounded allowance: the
 * uncertain row stays reserved (counted against caps) and the same request is
 * submitted under a numbered key. Completed results are always reused first. */
const UNCERTAIN = new Set(["SUBMITTED", "RECONCILIATION_REQUIRED"]);
export function documentarySupplyScope(ownerId: string, input: unknown, recoverLegacyOperator: boolean) {
  return { projectId: `documentary:${ownerId}:${stableHash(input, 16)}`,
    intentId: "documentary", recoverLegacyOperator };
}
/** Every SDK call/correction has its own upper-bound reservation. SDK retries MUST be zero.
 * Interrupted/uncertain submissions stay in the existing ledger; this helper never retries. */
export async function supplyProtectedAnthropic<T extends { usage?: ScriptUsage }>(
  params: { model: string; max_tokens: number } & Record<string, unknown>, invoke: () => Promise<T>,
): Promise<T> {
  if (!supplyGuardRequired()) return invoke();
  const pricing = getPricingConfig();
  const upperUsd = anthropicReservation(params, pricing);
  const scope = context.getStore() ?? { projectId: "operator-script", intentId: randomUUID() };
  const service = createServiceClient(), results = supabaseResultStore(service);
  // Older owner-only form submissions used operator-script. Reuse only an exact
  // parameter hash; never expose this legacy pool to ordinary customer accounts.
  if (scope.recoverLegacyOperator) {
    const { data, error } = await service.from("pi_paid_operations").select("result_ref")
      .eq("project_id", "operator-script").eq("provider", "anthropic").eq("model", params.model)
      .eq("method", "generate_script").eq("status", "COMMITTED")
      .like("shot_id", `script:%:${stableHash(params, 16)}`)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error("SCRIPT_RECOVERY_UNAVAILABLE");
    if (data) {
      if (!data.result_ref?.startsWith("operator-script/paid/")) throw new Error("SCRIPT_RECOVERY_INVALID_REFERENCE");
      const recovered = await results.getJson<T>(data.result_ref);
      if (!recovered) throw new Error("SCRIPT_RECOVERY_RESULT_MISSING");
      return recovered;
    }
  }
  const store = supabaseLedgerStore(service);
  const spec = {
    projectId: scope.projectId, shotId: `script:${scope.intentId}:${stableHash(params, 16)}`,
    provider: "anthropic", model: params.model, method: "generate_script",
    inputFingerprint: params, reservedUsd: upperUsd,
  };
  const existing = await selectResubmission(store, spec, scope.uncertainResubmits ?? 0);
  admitDocumentaryCall(existing?.status);
  const paid = await guardPaidCall<T>(store, spec, { async call({ key }) {
    const result = await invoke();
    const costUsd = anthropicActualCost(params, pricing, result.usage, upperUsd);
    const resultRef = paidResultPath(scope.projectId, key, "script.json");
    await results.putJson(resultRef, result);
    return { result, costUsd, resultRef };
  }, load: ref => results.getJson<T>(ref), classify: classifyAnthropicError, maxRejectedRetries: 0 });
  return paid.result;
}

/** Picks the ledger key for this request: the original, or — only within the
 * owner-granted allowance and only past an uncertain row — the next numbered
 * re-submission. A COMMITTED row at any step is reused, never paid again. */
export async function selectResubmission(store: Pick<LedgerStore, "get">, spec: PaidCallSpec, allowance: number) {
  const base = spec.shotId;
  let existing = await store.get(paidCallKey(spec));
  for (let r = 1; existing && UNCERTAIN.has(existing.status) && r <= allowance; r++) {
    spec.shotId = `${base}:resubmit-${r}`;
    existing = await store.get(paidCallKey(spec));
  }
  return existing;
}
