import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServiceClient } from "@/lib/supabase/service";
import { getPricingConfig } from "@/lib/billing/pricing";
import { guardPaidCall, paidCallKey, type LedgerStore, type PaidCallSpec } from "@/lib/paid-calls/gate";
import { supabaseLedgerStore } from "@/lib/paid-calls/supabase-ledger-store";
import { supabaseResultStore, paidResultPath, type PaidResultStore } from "@/lib/paid-calls/result-store";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { supplyGuardRequired } from "./server";
import { anthropicReservation, anthropicActualCost, ceilLedgerUsd, type ScriptUsage } from "./anthropic-cost";
import { classifyAnthropicError, SCRIPT_REJECTED_RETRIES, scriptRetryDelayMs } from "./anthropic-error";

import { admitDocumentaryCall } from "./documentary-step";
import { claimScriptOperation, decideScriptIntent, releaseStaleReservations, scriptBlockState, ScriptLedgerUnavailableError, ScriptReconciliationRequiredError, type ScriptOpRow } from "./script-intent";

const context = new AsyncLocalStorage<{ projectId: string; intentId: string; recoverLegacyOperator?: boolean; uncertainResubmits?: number; claimBeforeCall?: boolean }>();
export function withSupplyContext<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  return context.run({ projectId, intentId: randomUUID() }, fn);
}
/** Every guarded script call of this video request (any intent, legacy random ones included). */
export async function loadScriptOperations(projectId: string): Promise<ScriptOpRow[]> {
  const { data, error } = await createServiceClient().from("pi_paid_operations").select("status, shot_id, updated_at, idempotency_key")
    .eq("project_id", projectId).eq("provider", "anthropic").eq("method", "generate_script");
  if (error) throw new ScriptLedgerUnavailableError("script ledger read failed");
  return (data ?? []) as ScriptOpRow[];
}
/** Full script generation of one video request: a persistent intent (script-intent.ts) instead of a random one,
 * so a retry after an uncertain call hits the same ledger state and never pays twice. Throws
 * ScriptReconciliationRequiredError (no provider call, no reservation) while a call is uncertain or in flight. */
export async function withScriptGenerationContext<T>(projectId: string, fn: () => Promise<T>,
  deps: { guard?: boolean; load?: (projectId: string) => Promise<ScriptOpRow[]>; store?: Pick<LedgerStore, "get" | "update">; now?: () => number } = {}): Promise<T> {
  if (!(deps.guard ?? supplyGuardRequired())) return withSupplyContext(projectId, fn);
  const nowMs = (deps.now ?? Date.now)();
  let rows: ScriptOpRow[];
  try {
    rows = await releaseStaleReservations(deps.store ?? supabaseLedgerStore(createServiceClient()), await (deps.load ?? loadScriptOperations)(projectId), nowMs);
  } catch {
    // Nothing was reserved or sent yet: a ledger outage before the call is "try later", never "reconcile".
    throw new ScriptLedgerUnavailableError("script ledger read failed");
  }
  const { intentId } = decideScriptIntent(rows, nowMs);
  return context.run({ projectId, intentId, claimBeforeCall: true }, fn);
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
  // Rounded UP to the ledger's precision: the database budget/caps compare stored amounts.
  const upperUsd = ceilLedgerUsd(anthropicReservation(params, pricing));
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
  const paid = await guardScriptLedgerCall({ store: supabaseLedgerStore(service), results, load: loadScriptOperations }, scope, params, upperUsd,
    result => ceilLedgerUsd(anthropicActualCost(params, pricing, result.usage, upperUsd)), invoke);
  return paid.result;
}

type SupplyScope = NonNullable<ReturnType<typeof context.getStore>>;
/** The scope of the running supply context (tests run the guarded call under the real context). */
export const currentSupplyScope = (): SupplyScope | undefined => context.getStore();

/** The ledger part of supplyProtectedAnthropic, with injectable stores (memoryLedgerStore/memoryResultStore in tests). */
export async function guardScriptLedgerCall<T>(deps: { store: LedgerStore; results: Pick<PaidResultStore, "putJson" | "getJson">; now?: () => number; maxRejectedRetries?: number; retryDelayMs?: (attempt: number) => number;
  /** Every guarded script call of the request (loadScriptOperations in production): re-checked before each retry. */
  load?: (projectId: string) => Promise<ScriptOpRow[]> },
  scope: SupplyScope, params: { model: string } & Record<string, unknown>, upperUsd: number, actualCostUsd: (result: T) => number, invoke: () => Promise<T>) {
  const { store, results } = deps;
  // Before a retry calls the provider (its row already reserved, so no new intent could start meanwhile): any OTHER
  // operation of this request that is active or uncertain aborts the chain; nothing is called while it is unresolved.
  const beforeRetry = deps.load ? async () => {
    const rows = await deps.load!(scope.projectId);
    const foreign = rows.filter(r => !r.shot_id.startsWith(`script:${scope.intentId}:`));
    const state = scriptBlockState(foreign, (deps.now ?? Date.now)());
    if (state) throw new ScriptReconciliationRequiredError(state, "another operation of this request became active or uncertain during the retry wait");
  } : undefined;
  const spec = {
    projectId: scope.projectId, shotId: `script:${scope.intentId}:${stableHash(params, 16)}`,
    provider: "anthropic", model: params.model, method: "generate_script",
    inputFingerprint: params, reservedUsd: upperUsd,
  };
  const existing = await selectResubmission(store, spec, scope.uncertainResubmits ?? 0);
  admitDocumentaryCall(existing?.status);
  if (scope.claimBeforeCall) {
    await claimScriptOperation(store, { idempotencyKey: paidCallKey(spec), projectId: spec.projectId, shotId: spec.shotId, provider: spec.provider,
      model: spec.model, method: spec.method, attemptKind: "initial", reservedUsd: spec.reservedUsd }, (deps.now ?? Date.now)());
  }
  return guardPaidCall<T>(store, spec, { async call({ key }) {
    const result = await invoke();
    const costUsd = actualCostUsd(result);
    const resultRef = paidResultPath(scope.projectId, key, "script.json");
    await results.putJson(resultRef, result);
    return { result, costUsd, resultRef };
  }, load: ref => results.getJson<T>(ref), classify: classifyAnthropicError,
  // Only pre-acceptance refusals (429/529, classified `rejected`) are retried, each under its own key; never 401/403/5xx.
  maxRejectedRetries: deps.maxRejectedRetries ?? SCRIPT_REJECTED_RETRIES, retryDelayMs: deps.retryDelayMs ?? scriptRetryDelayMs, beforeRetry });
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
