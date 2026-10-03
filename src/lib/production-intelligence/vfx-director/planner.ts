import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { PlanSchema, DIRECTOR_INSTRUCTIONS, type Brief, type Inventory } from "./index";
import { BlockedDirectionSchema } from "./gates";
import { guardPaidCall, type LedgerStore } from "../../paid-calls/gate";
import type { PaidResultStore } from "../../paid-calls/result-store";
import { assertWithinReservation, reserveProject } from "../budget";
const ResponseSchema = z.union([z.object({ status: z.literal("PLANNED"), plan: PlanSchema }).strict(), BlockedDirectionSchema]);
/** Same Anthropic SDK/model configuration as the existing script adapter. Calls pass
 * through the existing durable paid-call gate; a zero budget blocks before the SDK. */
export async function claudeDirection(input: { brief: Brief; inventory: Inventory; assets: readonly string[] }, deps: {
  ledger: LedgerStore; results: PaidResultStore; client: Anthropic; model: string;
  quote: { maxUsd: number; maxInputTokens: number; maxOutputTokens: number; inputUsdPerMillion: number; outputUsdPerMillion: number; verifiedSource: string };
  call?: (request: Record<string, unknown>) => Promise<{ response: unknown; costUsd: number }>;
}) {
  const quote = deps.quote;
  if (!(Number.isFinite(quote.maxUsd) && quote.maxUsd > 0 && quote.maxInputTokens > 0 && quote.maxOutputTokens > 0 && quote.verifiedSource.startsWith("https://"))) throw new Error("VFX_PLANNER_QUOTE_UNVERIFIED");
  if (![quote.inputUsdPerMillion, quote.outputUsdPerMillion].every(rate => Number.isFinite(rate) && rate > 0)) throw new Error("VFX_PLANNER_RATE_MISSING");
  const worstUsd = (quote.maxInputTokens * quote.inputUsdPerMillion + quote.maxOutputTokens * quote.outputUsdPerMillion) / 1e6;
  if (worstUsd > quote.maxUsd) throw new Error("VFX_PLANNER_QUOTE_TOO_SMALL");
  const reservation = reserveProject(input.brief.projectId, { expectedCostUsd: quote.maxUsd, worstCaseUsd: quote.maxUsd }, input.brief.budgetUsd);
  assertWithinReservation(reservation, 0, quote.maxUsd);
  const body = JSON.stringify(input);
  // Conservative UTF-8 bytes upper bound, including system prompt.
  if (Buffer.byteLength(body + DIRECTOR_INSTRUCTIONS + JSON.stringify(zodOutputFormat(ResponseSchema))) > quote.maxInputTokens) throw new Error("VFX_PLANNER_INPUT_LIMIT");
  const spec = { projectId: input.brief.projectId, shotId: "vfx:direction", provider: "anthropic", model: deps.model,
    method: "vfx_direction", inputFingerprint: { input, instructions: DIRECTOR_INSTRUCTIONS, quote }, reservedUsd: quote.maxUsd };
  return guardPaidCall(deps.ledger, spec, {
    async call({ key }) {
      const request = { model: deps.model, max_tokens: quote.maxOutputTokens, system: DIRECTOR_INSTRUCTIONS,
        messages: [{ role: "user" as const, content: body }], output_config: { format: zodOutputFormat(ResponseSchema) } };
      const response = deps.call ? await deps.call(request) : await (async () => {
        const message = await deps.client.messages.create(request, { maxRetries: 0 });
        const text = message.content.filter(b => b.type === "text").map(b => b.text).join("");
        if (![message.usage.input_tokens, message.usage.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0) || message.usage.input_tokens + message.usage.output_tokens === 0) throw new Error("VFX_PLANNER_USAGE_MISSING");
        const costUsd = (message.usage.input_tokens * quote.inputUsdPerMillion + message.usage.output_tokens * quote.outputUsdPerMillion) / 1e6;
        return { response: JSON.parse(text), costUsd };
      })();
      const result = ResponseSchema.parse(response.response);
      if (!(response.costUsd >= 0 && response.costUsd <= quote.maxUsd)) throw new Error("VFX_PLANNER_COST_INVALID");
      const resultRef = `${input.brief.projectId}/paid/${key}.json`;
      await deps.results.putJson(resultRef, result);
      return { result, costUsd: response.costUsd, resultRef };
    },
    async load(ref) { const stored = await deps.results.getJson(ref); return stored ? ResponseSchema.parse(stored) : null; },
    maxRejectedRetries: 0,
  });
}
