import { test } from "node:test";
import assert from "node:assert/strict";
import { documentarySupplyScope } from "./anthropic";
import { paidCallKey } from "@/lib/paid-calls/gate";
import { stableHash } from "@/lib/production-intelligence/canonical";

const fields = { topic: "Salamis", language: "en", durationMinutes: "10", sources: "verified" };
const params = { model: "claude-sonnet-5", max_tokens: 16000, prompt: "original" };
function key(owner: string, input: unknown, payload = params) {
  const scope = documentarySupplyScope(owner, input, false);
  return paidCallKey({ projectId: scope.projectId, shotId: `script:${scope.intentId}:${stableHash(payload, 16)}`,
    provider: "anthropic", model: payload.model, method: "generate_script", inputFingerprint: payload, reservedUsd: .2 });
}
test("repeated documentary form submissions reuse the same paid key", () => {
  assert.equal(key("owner", fields), key("owner", { ...fields }));
});
test("different owners, inputs and correction prompts never share paid keys", () => {
  const original = key("owner", fields);
  assert.notEqual(original, key("another-owner", fields));
  assert.notEqual(original, key("owner", { ...fields, language: "es" }));
  assert.notEqual(original, key("owner", fields, { ...params, prompt: "duration correction" }));
});
test("legacy operator recovery must be explicitly enabled by the trusted owner check", () => {
  assert.equal(documentarySupplyScope("owner", fields, false).recoverLegacyOperator, false);
  assert.equal(documentarySupplyScope("owner", fields, true).recoverLegacyOperator, true);
});
