/**
 * One source for what an image costs BEFORE it is generated (anexo C1, corrección 2). The OpenAI provider refuses a
 * request whose static estimate is above the per-call maximum it receives (openai.ts, «budget_exceeded»), so whoever
 * budgets an image (the Director's unit cost, the fill's per-call maximum) must read the SAME estimate. Pure, no I/O.
 *
 * The final charge is computed from the tokens the provider reports (openai.ts computeUsageCostUsd) and can differ
 * from the estimate: the provider does not enforce an exact ceiling. The Director therefore plans with a
 * conservative margin over the estimate; the ledger records the real cost of each call.
 */
type Env = Record<string, string | undefined>;

/** Static per-image estimate of the OpenAI provider (same variable and default openai.ts always used). */
export function openaiImageEstimatedCostUsd(env: Env = process.env): number {
  const n = Number(env.OPENAI_IMAGE_ESTIMATED_COST_USD || "0.05");
  return Number.isFinite(n) && n > 0 ? n : 0.05;
}

/** Margin over the estimate for planning (token-billed cost is not physically capped by the provider). */
export const IMAGE_PLANNING_MARGIN = 1.25;

/** The Director's unit cost of one new AI image: estimate × margin, rounded UP to cents (default 0.05 → 0.07). */
export function directorImageUnitCostUsd(env: Env = process.env): number {
  return Math.ceil(openaiImageEstimatedCostUsd(env) * IMAGE_PLANNING_MARGIN * 100 - 1e-9) / 100;
}

/**
 * What changes the IMAGE a request produces for the same prompt (provider, model, quality, portrait size), with the
 * same defaults openai.ts uses. Part of the fill's content key, so a configuration change never reuses an old image.
 */
export function imageVariant(providerName: string, env: Env = process.env): string {
  if (providerName !== "openai") return providerName;
  return ["openai", env.OPENAI_IMAGE_MODEL || "gpt-image-2", env.OPENAI_IMAGE_QUALITY || "medium", env.OPENAI_IMAGE_SIZE || "1024x1536"].join(":");
}
