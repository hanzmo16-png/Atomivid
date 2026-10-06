import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicReservation, anthropicActualCost } from "./anthropic-cost";
const rates = { scriptInputUsdPer1MTokens: 2, scriptOutputUsdPer1MTokens: 10 };
const writer = { model: "claude-sonnet-5", max_tokens: 16000, messages: [{ role: "user", content: "Write" }] };
const research = { ...writer, max_tokens: 4000, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }] };
test("plain script reservation remains request bytes plus overhead and output cap", () => {
  assert.equal(anthropicReservation(writer, rates), ((Buffer.byteLength(JSON.stringify(writer)) + 8192) * 2 + 16000 * 10) / 1e6);
});
test("research reserves context expansion and search charge; actual accounting includes search", () => {
  assert.ok(Math.abs(anthropicReservation(research, rates) - 4.09) < 1e-9);
  assert.equal(anthropicActualCost(research, rates, { input_tokens: 10000, output_tokens: 2000, server_tool_use: { web_search_requests: 1 } }, 4.09), .05);
  assert.equal(anthropicActualCost(research, rates, { input_tokens: 10000, output_tokens: 2000 }, 4.09), 4.09);
  assert.equal(anthropicActualCost(writer, rates, undefined, .5), .5);
});
test("unbounded tools, other tools and unverified model contexts cannot pass cost verification", () => {
  for (const p of [
    { ...research, model: "unverified-model" },
    { ...research, tools: [{ ...research.tools[0], max_uses: 2 }] },
    { ...research, tools: [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 1 }] },
    { ...research, tools: [] },
  ]) assert.throws(() => anthropicReservation(p, rates), /SCRIPT_TOOL_COST_UNVERIFIED/);
});
