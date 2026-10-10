/**
 * Orchestrator configuration, read from the server environment only (never from Drive files).
 *
 * Three independent gates protect money:
 *  1. Kill switch: nothing runs unless ORCHESTRATOR_ENABLED === "true"; a store-level "kill" flag also stops it.
 *  2. Paid calls: the OpenAI auditor is only used when ORCH_ALLOW_PAID_CALLS === "true" AND the run was approved
 *     (ORCH_PAID_APPROVAL === "GASTAR-HASTA-<cap>USD" with the exact cap), AND a durable store is configured.
 *     Otherwise the simulated auditor (USD 0) is used.
 *  3. Budget: a separate ledger (not Atomivid's production pi_paid_operations) with a hard cap, per-call and daily
 *     limits, reserved before every call with the worst case and settled with the real usage.
 */
export type OrchestratorConfig = {
  enabled: boolean;
  paidCalls: boolean;
  /** Why paid calls are off (for logs/reports), null when on. */
  paidBlockedReason: string | null;
  model: string;
  /** USD per 1M tokens. Must be set explicitly for any non-default model. */
  priceInputPerM: number;
  priceOutputPerM: number;
  maxOutputTokens: number;
  maxInputChars: number;
  budgetCapUsd: number;
  maxCallUsd: number;
  maxCallsPerDay: number;
  maxCallsPerRun: number;
  /** Automatic attempts per task chain before it blocks (mission rule: 3). */
  maxAttempts: number;
  /** HTTP retries for transient OpenAI errors inside one call (each retry is reserved/counted). */
  maxHttpRetries: number;
};

/** Defaults: a cheap non-reasoning model; prices as listed by trackers in 2026 (verify on openai.com before paying). */
export const DEFAULT_MODEL = "gpt-4.1-nano";
const DEFAULT_PRICES: Record<string, { in: number; out: number }> = { "gpt-4.1-nano": { in: 0.1, out: 0.4 } };
export const PILOT_BUDGET_USD = 5;

const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function loadConfig(env: Record<string, string | undefined> = process.env, opts: { durableStore: boolean } = { durableStore: false }): OrchestratorConfig {
  const model = env.ORCH_OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const known = DEFAULT_PRICES[model];
  const priceInputPerM = num(env.ORCH_PRICE_INPUT_PER_M, known?.in ?? NaN);
  const priceOutputPerM = num(env.ORCH_PRICE_OUTPUT_PER_M, known?.out ?? NaN);
  // The pilot cap can only be lowered by configuration, never raised above Hans's authorisation.
  const budgetCapUsd = Math.min(PILOT_BUDGET_USD, Math.max(0, num(env.ORCH_BUDGET_CAP_USD, PILOT_BUDGET_USD)));
  const cfg: OrchestratorConfig = {
    enabled: env.ORCHESTRATOR_ENABLED === "true",
    paidCalls: false,
    paidBlockedReason: null,
    model,
    priceInputPerM,
    priceOutputPerM,
    maxOutputTokens: Math.min(4000, Math.max(200, num(env.ORCH_MAX_OUTPUT_TOKENS, 1200))),
    maxInputChars: Math.min(60_000, Math.max(2_000, num(env.ORCH_MAX_INPUT_CHARS, 24_000))),
    budgetCapUsd,
    maxCallUsd: Math.min(0.05, Math.max(0.001, num(env.ORCH_MAX_CALL_USD, 0.01))),
    maxCallsPerDay: Math.min(200, Math.max(1, num(env.ORCH_MAX_CALLS_PER_DAY, 40))),
    maxCallsPerRun: Math.min(20, Math.max(1, num(env.ORCH_MAX_CALLS_PER_RUN, 5))),
    maxAttempts: 3,
    maxHttpRetries: 2,
  };
  const approval = `GASTAR-HASTA-${budgetCapUsd}USD`;
  if (env.ORCH_ALLOW_PAID_CALLS !== "true") cfg.paidBlockedReason = "ORCH_ALLOW_PAID_CALLS no está activado";
  else if (env.ORCH_PAID_APPROVAL !== approval) cfg.paidBlockedReason = `falta la aprobación explícita de Hans (${approval}) para esta ejecución`;
  else if (!env.OPENAI_API_KEY?.trim()) cfg.paidBlockedReason = "OPENAI_API_KEY no está configurada";
  else if (!Number.isFinite(priceInputPerM) || !Number.isFinite(priceOutputPerM)) cfg.paidBlockedReason = `faltan los precios de ${model} (ORCH_PRICE_INPUT_PER_M / ORCH_PRICE_OUTPUT_PER_M)`;
  else if (!opts.durableStore) cfg.paidBlockedReason = "el gasto necesita un almacén durable (Supabase del orquestador) para que el presupuesto persista entre ejecuciones";
  else cfg.paidCalls = true;
  return cfg;
}
