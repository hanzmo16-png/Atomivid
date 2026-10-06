type Params = { model: string; max_tokens: number } & Record<string, unknown>;
type Rates = { scriptInputUsdPer1MTokens: number; scriptOutputUsdPer1MTokens: number };
export type ScriptUsage = { input_tokens: number; output_tokens: number;
  server_tool_use?: { web_search_requests: number } | null };

/** Search price: $10/1,000 searches. Native search results also consume tokens.
 * The only admitted tool configuration is one search on the verified 1M-context
 * model. Reserve two full contexts (search + synthesis), not merely request bytes.
 * This intentionally conservative reservation is NOT a quoted/charged cost.
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
 */
export function anthropicReservation(params: Params, rates: Rates): number {
  let input = Buffer.byteLength(JSON.stringify(params)) + 8192;
  let output = params.max_tokens, searchUsd = 0;
  if (params.tools !== undefined) {
    const ts = params.tools;
    if (!Array.isArray(ts) || ts.length !== 1 || params.model !== "claude-sonnet-5"
      || ts[0]?.type !== "web_search_20250305" || ts[0]?.name !== "web_search" || ts[0]?.max_uses !== 1)
      throw new Error("SCRIPT_TOOL_COST_UNVERIFIED");
    input = Math.max(input, 2_000_000);
    output *= 2;
    searchUsd = .01;
  }
  const usd = (input * rates.scriptInputUsdPer1MTokens + output * rates.scriptOutputUsdPer1MTokens) / 1e6 + searchUsd;
  if (!(usd > 0) || !Number.isFinite(usd)) throw new Error("SCRIPT_SUPPLY_COST_UNVERIFIED");
  return usd;
}

export function anthropicActualCost(params: Params, rates: Rates, usage: ScriptUsage | undefined, reserved: number): number {
  if (!usage || !Number.isFinite(usage.input_tokens) || usage.input_tokens < 0
    || !Number.isFinite(usage.output_tokens) || usage.output_tokens < 0) return reserved;
  const searches = usage.server_tool_use?.web_search_requests;
  if (params.tools && (!Number.isInteger(searches) || (searches ?? -1) < 0)) return reserved;
  return (usage.input_tokens * rates.scriptInputUsdPer1MTokens + usage.output_tokens * rates.scriptOutputUsdPer1MTokens) / 1e6
    + (searches ?? 0) * .01;
}
