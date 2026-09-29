/**
 * Business Telemetry V0 — provider consumption trace.
 * PRODUCTION → SHOT/OPERATION → PROVIDER → MODEL → UNITS → ACTUAL COST → RETRY/FALLBACK → EVENT.
 * The actual figure is NEVER recalculated here: it is copied from the Cost Engine (COMMITTED
 * entry) or from the paid-operation ledger (COMMITTED row). A top-up / credit grant is a
 * balance event and is refused: PROVIDER TOP-UP != COGS.
 */
import type { BalanceEvent, CostEntry } from "../production-core/cost-engine";
import type { BusinessEvent, BusinessEventInput } from "./ledger";

export class NotConsumptionError extends Error { constructor(m: string) { super(m); this.name = "NotConsumptionError"; } }

export type AttemptKind = "initial" | "retry" | "fallback";
export type TraceContext = { attemptKind: AttemptKind; fallbackFromProvider?: string | null; model?: string | null; units?: { quantity: number; unit: "usd" | "seconds" | "characters" | "images" | "tokens" | "calls" } | null; source: string; actorId?: string | null };

const check = (ctx: TraceContext) => { if (ctx.attemptKind === "fallback" && !ctx.fallbackFromProvider) throw new NotConsumptionError("a fallback attempt must name the provider it replaced"); if (ctx.attemptKind !== "fallback" && ctx.fallbackFromProvider) throw new NotConsumptionError("fallback_from_provider is only valid for a fallback attempt"); };

/** From a Cost Engine entry. Only COMMITTED with an actual figure; RECONCILIATION_REQUIRED must be resolved first. */
export function consumptionFromCostEntry(e: CostEntry, ctx: TraceContext): BusinessEventInput {
  check(ctx);
  if (e.status === "RECONCILIATION_REQUIRED") throw new NotConsumptionError(`${e.costKey}: reconciliation required; the actual figure is disputed`);
  if (e.status !== "COMMITTED" || e.actualUsd === null) throw new NotConsumptionError(`${e.costKey}: only COMMITTED entries with an actual figure are consumption (status ${e.status})`);
  return {
    eventType: "provider_consumption_recorded", occurredAt: e.updatedAt, actorType: "system", actorId: ctx.actorId ?? null,
    productionId: e.requestId, requestId: e.requestId, provider: e.provider, source: ctx.source, provenance: "derived_from_canonical_record",
    idempotencyKey: `provider_consumption_recorded:cost_engine:${e.costKey}`,
    metadata: { cost_source: "cost_engine", operation_key: e.costKey, shot_id: e.shotId, model: ctx.model ?? null, method: e.method, attempt_kind: ctx.attemptKind, fallback_from_provider: ctx.fallbackFromProvider ?? null, units: ctx.units ?? null, actual: { amount: e.actualUsd, currency: "USD" }, consumption_kind: "committed_consumption" },
  };
}

export type PaidOperationRow = { idempotencyKey: string; projectId: string; shotId: string; provider: string; model: string; method: string; attemptKind: string; committedUsd: number | null; status: string; updatedAt: string };
/** From a pi_paid_operations row (the ledger is the truth; USD by definition of that table). */
export function consumptionFromPaidOperation(r: PaidOperationRow, ctx: Omit<TraceContext, "attemptKind" | "model"> & { attemptKind?: AttemptKind }): BusinessEventInput {
  const attemptKind: AttemptKind = ctx.attemptKind ?? (r.attemptKind === "initial" ? "initial" : r.attemptKind === "fallback" ? "fallback" : "retry");
  check({ ...ctx, attemptKind });
  if (r.status !== "COMMITTED" || r.committedUsd === null) throw new NotConsumptionError(`${r.idempotencyKey}: only COMMITTED paid operations are consumption (status ${r.status})`);
  return {
    eventType: "provider_consumption_recorded", occurredAt: r.updatedAt, actorType: "system", actorId: ctx.actorId ?? null,
    productionId: r.projectId, requestId: r.projectId, provider: r.provider, source: ctx.source, provenance: "derived_from_canonical_record",
    idempotencyKey: `provider_consumption_recorded:pi_paid_operations:${r.idempotencyKey}`,
    metadata: { cost_source: "pi_paid_operations", operation_key: r.idempotencyKey, shot_id: r.shotId, model: r.model, method: r.method, attempt_kind: attemptKind, fallback_from_provider: ctx.fallbackFromProvider ?? null, units: ctx.units ?? null, actual: { amount: r.committedUsd, currency: "USD" }, consumption_kind: "committed_consumption" },
  };
}

/** A recharge is capacity, never cost of production. There is no event for it in V0. */
export function consumptionFromBalanceEvent(b: BalanceEvent): never {
  throw new NotConsumptionError(`${b.kind} of USD ${b.amountUsd} at ${b.provider} is a balance event, not COGS — no consumption event is recorded`);
}

export type ProductionTrace = {
  productionId: string;
  providers: string[];
  operations: { operationKey: string; provider: string; model: string | null; method: string; shotId: string | null; attemptKind: AttemptKind; fallbackFromProvider: string | null; amount: number; currency: string; costSource: string; occurredAt: string }[];
  fallbacks: { from: string; to: string; operationKey: string }[];
  totalByCurrency: Record<string, number>;
  note: string;
};

/** Read-only reconstruction of "this video cost X because it really used …" from recorded facts. Sums per currency, never converts. */
export function traceProduction(productionId: string, events: BusinessEvent[]): ProductionTrace {
  const ops = events.filter((e) => e.eventType === "provider_consumption_recorded" && e.productionId === productionId).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId)).map((e) => {
    const m = e.metadata as { operation_key: string; model: string | null; method: string; shot_id: string | null; attempt_kind: AttemptKind; fallback_from_provider: string | null; actual: { amount: number; currency: string }; cost_source: string };
    return { operationKey: m.operation_key, provider: e.provider ?? "unknown", model: m.model, method: m.method, shotId: m.shot_id, attemptKind: m.attempt_kind, fallbackFromProvider: m.fallback_from_provider, amount: m.actual.amount, currency: m.actual.currency, costSource: m.cost_source, occurredAt: e.occurredAt };
  });
  const totalByCurrency: Record<string, number> = {};
  for (const o of ops) totalByCurrency[o.currency] = Math.round(((totalByCurrency[o.currency] ?? 0) + o.amount) * 1e4) / 1e4;
  return { productionId, providers: [...new Set(ops.map((o) => o.provider))].sort(), operations: ops, fallbacks: ops.filter((o) => o.attemptKind === "fallback" && o.fallbackFromProvider).map((o) => ({ from: o.fallbackFromProvider as string, to: o.provider, operationKey: o.operationKey })), totalByCurrency, note: "sum of committed consumption facts recorded by the Cost Engine / paid-operation ledger; not an estimate, no FX" };
}
