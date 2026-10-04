import test from "node:test";
import assert from "node:assert/strict";
import { assertOwnerPilot, OwnerPilotSchema, type PilotRequest } from "./owner-pilot";
import { stableHash } from "@/lib/production-intelligence/canonical";
const script = { title: "Océano", segments: [{ text: "Explora el océano.", visualQuery: "ocean waves" }] };
const owner = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const grant = OwnerPilotSchema.parse({ version: "owner-pilot/1", ownerId: owner, requestId: id,
  expiresAt: "2026-10-06T00:00:00Z", scriptSha256: stableHash(script, 64), maxDurationSeconds: 30,
  maxRenderAttempts: 1, budgetVerified: true, maxVoiceCalls: 2, maxVoiceCharacters: 600,
  billingBasis: "prepaid_no_overage", voiceUsdPer1kChars: 0, maxProviderUsd: 0, voiceId: "configured-voice", modelId: "eleven_multilingual_v2", quoteEvidence: "verified private preflight" });
const row: PilotRequest = { id, user_id: owner, mode: "visual", duration_seconds: 30, script_json: script, render_attempts: 0 };
const user = { id: owner, email_confirmed_at: "2026-10-01T00:00:00Z" };
const now = Date.parse("2026-10-04T00:00:00Z");
test("pilot grants only one exact request and confirmed owner", () => {
  assert.doesNotThrow(() => assertOwnerPilot(grant, row, user, "admission", now));
  for (const changed of [{ ...row, id: owner }, { ...row, user_id: id }, { ...row, mode: "avatar" }, { ...row, duration_seconds: 60 }]) {
    assert.throws(() => assertOwnerPilot(grant, changed, user, "admission", now));
  }
  assert.throws(() => assertOwnerPilot(grant, row, { id: owner }, "admission", now));
  assert.throws(() => assertOwnerPilot(grant, row, user, "admission", Date.parse(grant.expiresAt)));
});
test("edits and a second render cannot reuse the paid authorization", () => {
  assert.throws(() => assertOwnerPilot(grant, { ...row, script_json: { ...script, title: "Different" } }, user, "admission", now));
  assert.throws(() => assertOwnerPilot(grant, { ...row, render_attempts: 1 }, user, "admission", now));
  assert.doesNotThrow(() => assertOwnerPilot(grant, { ...row, render_attempts: 1 }, user, "worker", now));
  assert.throws(() => assertOwnerPilot(grant, { ...row, render_attempts: 2 }, user, "worker", now));
});
test("unknown budget or unlimited grants cannot be parsed", () => {
  assert.equal(OwnerPilotSchema.safeParse({ ...grant, budgetVerified: false }).success, false);
  assert.equal(OwnerPilotSchema.safeParse({ ...grant, maxRenderAttempts: 3 }).success, false);
  assert.equal(OwnerPilotSchema.safeParse({ ...grant, maxProviderUsd: 10 }).success, false);
});
