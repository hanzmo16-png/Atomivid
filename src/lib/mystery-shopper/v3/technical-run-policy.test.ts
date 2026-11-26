import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { allocationRefusal, TECHNICAL_POLICY, technicalReserveRefusal, readTechnicalLedger } from "../../../../scripts/mystery-shopper/technical-run-policy";
const now = Date.parse("2026-11-26T12:00:00Z"), binding = { requestId: "new", reviewSha256: "a".repeat(64), ownerId: "owner", now };
const allocation = { scope: "OWNER_APPROVED_ONE_TECHNICAL_LONG_FORM_RUN", approved: true, ...binding, ownerReplyRef: "explicit-owner-reply", ownerReplySha256: "c".repeat(64), approvedAt: "2026-11-26T11:00:00Z", expiresAt: "2026-11-26T13:00:00Z", maxNewUsd: 2, totalCapUsd: 8.5, reservedAvUsd: 3, moduleCaps: TECHNICAL_POLICY, ledgerBaselineSha256: "b".repeat(64) };
const at = "2026-11-26T11:00:00Z";
test("owner receipt defaults deny; expiration, ownership, exact allocation and bindings cannot be substituted", () => {
  assert.equal(allocationRefusal(allocation, binding), null);
  for (const receipt of [undefined, {}, { ...allocation, approved: false }, { ...allocation, requestId: "other" }, { ...allocation, ownerId: "other" }, { ...allocation, reviewSha256: "other" }, { ...allocation, ownerReplyRef: "" }, { ...allocation, expiresAt: at }, { ...allocation, maxNewUsd: 3 }, { ...allocation, reservedAvUsd: 0 }, { ...allocation, totalCapUsd: 10 }, { ...allocation, moduleCaps: { ...TECHNICAL_POLICY, youtube: 5 } }, { ...allocation, ledgerBaselineSha256: "" }]) assert.ok(allocationRefusal(receipt, binding));
  assert.equal(Object.values(TECHNICAL_POLICY).reduce((n, value) => n + value, 0), 8.5);
});
test("all historical exposure counts, AV three dollars stays reserved, and duplicate or ambiguous history refuses", () => {
  const history: any = { reservations: [{ key: "old", module: "youtube", jobId: "job", reservedUsd: 2, at }], settlements: [{ key: "old", spentUsd: 2, source: "conservative historic ceiling", at }] };
  const original = JSON.stringify(history);
  assert.equal(technicalReserveRefusal(history, "new", 1.64), null);
  for (const quote of [NaN, Infinity, 0, -1, 2.01]) assert.ok(technicalReserveRefusal(history, "new", quote));
  assert.ok(technicalReserveRefusal(history, "old", 1));
  assert.ok(technicalReserveRefusal({ ...history, settlements: [...history.settlements, history.settlements[0]] }, "new", 1));
  assert.ok(technicalReserveRefusal({ ...history, settlements: [{ ...history.settlements[0], spentUsd: 2.01 }] }, "new", 1));
  assert.ok(technicalReserveRefusal({ ...history, settlements: [] }, "new", 1));
  assert.ok(technicalReserveRefusal({ ...history, reservations: [...history.reservations, { key: "a", module: "audio-podcast", jobId: "j", reservedUsd: 1.01, at }] }, "new", 1));
  assert.ok(technicalReserveRefusal({ ...history, reservations: [...history.reservations, { key: "unknown", module: "unknown", jobId: "j", reservedUsd: 0.1, at }] }, "new", 1));
  assert.equal(JSON.stringify(history), original);
});
test("STOP, truncated listings, unknown files, missing downloads and mismatched ledger keys fail closed", async () => {
  for (const names of [["STOP"], Array(1000).fill("reserve-one.json"), ["unknown.json"], ["reserve-one.json"]]) {
    const bucket = { async list() { return { data: names.map(name => ({ name })), error: null }; }, async download() { return { data: null, error: null }; } };
    await assert.rejects(() => readTechnicalLedger(bucket));
  }
  await assert.rejects(() => readTechnicalLedger({ async list() { return { data: [{ name: "reserve-one.json" }], error: null }; }, async download() { return { data: { text: async () => JSON.stringify({ key: "other" }) }, error: null }; } }));
});
test("owner receipt recorder defaults off and refuses a non-root actor before any storage or auth operation", () => {
  for (const extra of [{ MS_TECHNICAL_OPERATION: "review" }, { MS_TECHNICAL_OPERATION: "record-owner-allocation", MS_ROOT_ACTUAL_REPLY_REVIEWED: "1", GITHUB_RUN_ID: "test", GITHUB_ACTOR: "collaborator", GITHUB_REPOSITORY_OWNER: "owner", MS_OWNER_REPLY_REF: "actual-reply-ref", MS_OWNER_REPLY_SHA: "a".repeat(64) }]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/mystery-shopper/record-technical-owner-allocation.mjs"], { env: { ...process.env, ...extra }, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Owner approval recording refused/);
  }
});
test("deployment proof recorder defaults off and unreviewed source cannot create a readiness proof", () => {
  for (const extra of [{ MS_TECHNICAL_OPERATION: "deny" }, { MS_TECHNICAL_OPERATION: "record-reviewed-production-proof", MS_ROOT_SOURCE_REVIEW: "unreviewed", GITHUB_ACTOR: "owner", GITHUB_REPOSITORY_OWNER: "owner" }]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/mystery-shopper/record-technical-deployment-proof.mjs"], { env: { ...process.env, ...extra }, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Root deployment proof refused/);
  }
});
