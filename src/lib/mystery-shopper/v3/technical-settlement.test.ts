import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { technicalSettlementAmount } from "../../../../scripts/mystery-shopper/technical-settlement-checks";
const ops = [{ method: "tts", status: "COMMITTED", reserved_usd: 0.5, committed_usd: 0.321 }];
const generation = { estimated_cost_usd: 0.411, render_ms: 1200, script_calls: 0 };
test("settlement rounds max upward instead of summing overlapping registered voice and provider cost", () => {
  assert.equal(technicalSettlementAmount(ops, generation, 1, 0.42), 0.42);
  assert.equal(technicalSettlementAmount(ops, { ...generation, estimated_cost_usd: 0.21 }, 1, 0.33), 0.33);
  assert.throws(() => technicalSettlementAmount(ops, generation, 1, 0.74));
  assert.throws(() => technicalSettlementAmount(ops, generation, 0.4, 0.42));
  for (const status of ["RESERVED", "SUBMITTED", "REFUNDED", "RECONCILIATION_REQUIRED"]) assert.throws(() => technicalSettlementAmount([{ ...ops[0], status }], generation, 1, 0.42));
  assert.throws(() => technicalSettlementAmount([{ ...ops[0], committed_usd: null }], generation, 1, 0.42));
  assert.throws(() => technicalSettlementAmount(ops, { ...generation, estimated_cost_usd: null }, 1, 0.42));
});
test("settlement operation defaults deny and non-root actor cannot reach storage or auth", () => {
  for (const extra of [{ MS_TECHNICAL_OPERATION: "deny" }, { MS_TECHNICAL_OPERATION: "settle-root-reviewed-native-cost", MS_ROOT_COST_REVIEWED: "1", GITHUB_ACTOR: "collaborator", GITHUB_REPOSITORY_OWNER: "owner" }]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/mystery-shopper/settle-technical-native-once.mjs"], { env: { ...process.env, ...extra }, encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /Private settlement blocked/);
  }
});
test("free final ledger reader defaults deny and non-root cannot mutate or inspect financial state", () => {
  for (const extra of [{ MS_TECHNICAL_OPERATION: "deny" }, { MS_TECHNICAL_OPERATION: "read-final-ledger", GITHUB_ACTOR: "collaborator", GITHUB_REPOSITORY_OWNER: "owner" }]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/mystery-shopper/read-technical-final-ledger.mjs"], { env: { ...process.env, ...extra }, encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /Private final-ledger readback unavailable/);
  }
});
