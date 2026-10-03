import test from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { claudeDirection } from "./planner";
import { memoryLedgerStore } from "../ledger";
import { memoryResultStore } from "../../paid-calls/result-store";
const input = { brief: { projectId: "planner-test", intent: "transform", emotion: "surprise", frames: 150, fps: 30, width: 1080, height: 1920, sourceSha256: "a".repeat(64), subjectLock: "original_pixels" as const, budgetUsd: 0, environments: [] }, inventory: {}, assets: ["source"] };
test("zero budget prevents model invocation and ledger writes", async () => {
  const ledger = memoryLedgerStore(); let calls = 0;
  await assert.rejects(claudeDirection(input, { ledger, results: memoryResultStore(), client: new Anthropic({ apiKey: "test-only" }), model: "test", quote: { maxUsd: 0.1, maxInputTokens: 16000, maxOutputTokens: 1000, inputUsdPerMillion: 1, outputUsdPerMillion: 1, verifiedSource: "https://example.test/fixture-quote" }, call: async () => { calls++; return { response: {}, costUsd: 0 }; } }));
  assert.equal(calls, 0); assert.equal(ledger.writes, 0);
});
test("planning result is stored and reused; resume does not ask Claude twice", async () => {
  const ledger = memoryLedgerStore(); let calls = 0;
  const deps = { ledger, results: memoryResultStore(), client: new Anthropic({ apiKey: "test-only" }), model: "test", quote: { maxUsd: 0.1, maxInputTokens: 16000, maxOutputTokens: 1000, inputUsdPerMillion: 1, outputUsdPerMillion: 1, verifiedSource: "https://example.test/fixture-quote" }, call: async () => { calls++; return { response: { status: "NEEDS_MATERIAL", reason: "no full body", requiredMaterial: ["source"] }, costUsd: 0 }; } };
  const paidFixtureInput = { ...input, brief: { ...input.brief, budgetUsd: 1 } };
  const first = await claudeDirection(paidFixtureInput, deps); const second = await claudeDirection(paidFixtureInput, deps);
  assert.equal(calls, 1); assert.deepEqual(first.result, second.result); assert.equal(second.reused, true);
});
