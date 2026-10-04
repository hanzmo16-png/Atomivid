import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { OwnerFormTrialSchema, assertOwnerFormTrial } from "./owner-form-trial";
import { ownerFormTrialLedger } from "@/lib/paid-calls/owner-form-trial-ledger";
import { guardPaidCall } from "@/lib/paid-calls/gate";

const grant = OwnerFormTrialSchema.parse({ version: "owner-form-trial/1",
  ownerId: "d2064950-7a95-4208-8dfb-d93b470d141d", requestId: "34bc43f3-a53d-4daa-b8fa-bef3f1544b04",
  expiresAt: "2026-10-07T23:00:00Z", topic: "Negocio", style: "Motivacional", language: "es", durationSeconds: 30,
  maxAccountedUsd: 1.25, maxScriptCalls: 3, scriptReservationUsd: 0.15, scriptModel: "claude-sonnet-5",
  maxVoiceCalls: 2, maxVoiceCharacters: 1000, voiceId: "uYlzyj2kIZo3HfBB21vF", voiceModel: "eleven_multilingual_v2",
  maxImages: 6, maxImageReservationUsd: 0.08, maxReviews: 20, maxRenderAttempts: 1,
  authorization: "2026-10-04:owner-authorized-form-test" });
const user = { id: grant.ownerId, email_confirmed_at: "2026-10-01T00:00:00Z" };
const now = Date.parse("2026-10-04T23:00:00Z");
const row = { id: grant.requestId, user_id: grant.ownerId, mode: "visual", topic: grant.topic, style: grant.style,
  duration_seconds: 30, language: "es", status: "script_ready", render_attempts: 0,
  script_json: { title: "Negocio", segments: [{ text: "Habla con clientes.", visualQuery: "customer meeting",
    visualIntent: { source: "stock" as const, subject: "customer interview", mustShow: ["two people speaking"],
      mustNotShow: ["cryptocurrency trading"], imagePrompt: "Two entrepreneurs interviewing a customer at an office." } }] } };

test("trial scope requires a confirmed owner, exact input, expiry, and a single render", () => {
  assert.doesNotThrow(() => assertOwnerFormTrial(grant, row, user, "script", now));
  assert.doesNotThrow(() => assertOwnerFormTrial(grant, row, user, "admission", now));
  assert.doesNotThrow(() => assertOwnerFormTrial(grant, { ...row, status: "processing", render_attempts: 1 }, user, "worker", now));
  for (const changes of [{ mode: "avatar" }, { id: user.id }, { user_id: row.id }, { duration_seconds: 60 },
    { topic: "different" }, { style: "different" }, { language: "en" }, { render_attempts: 1 }, { render_attempts: -1 }])
    assert.throws(() => assertOwnerFormTrial(grant, { ...row, ...changes }, user, "admission", now));
  assert.throws(() => assertOwnerFormTrial(grant, row, { ...user, email_confirmed_at: undefined }, "admission", now));
  assert.throws(() => assertOwnerFormTrial(grant, row, user, "admission", Date.parse(grant.expiresAt)));
  assert.throws(() => assertOwnerFormTrial(grant, { ...row, status: "processing", render_attempts: 1 }, user, "script", now));
});

test("trial refuses invalid visual plans, too many scenes and excessive narration before dispatch", () => {
  for (const segments of [[{ text: "x", visualQuery: "x" }], Array(7).fill(row.script_json.segments[0]),
    [{ ...row.script_json.segments[0], text: "x".repeat(1001) }]])
    assert.throws(() => assertOwnerFormTrial(grant, { ...row, script_json: { title: "x", segments } }, user, "admission", now));
  assert.equal(OwnerFormTrialSchema.safeParse({ ...grant, maxAccountedUsd: 99 }).success, false);
  assert.equal(OwnerFormTrialSchema.safeParse({ ...grant, maxVoiceCalls: 3 }).success, false);
});

test("the paid gate makes no provider call when the atomic trial reservation fails", async () => {
  let reservations = 0, calls = 0;
  const query = { select() { return query; }, eq() { return query; }, maybeSingle: async () => ({ data: null, error: null }) };
  const service = { from: () => query, rpc: async () => { reservations++; return { data: null, error: { code: "BUDGET_BLOCKED" } }; } } as unknown as SupabaseClient;
  const ledger = ownerFormTrialLedger(service, grant);
  await assert.rejects(guardPaidCall(ledger, { projectId: grant.requestId, shotId: "script:main-1", provider: "anthropic",
    model: grant.scriptModel, method: "generate_script", reservedUsd: 0.15, inputFingerprint: { input: "x" } }, {
    call: async () => { calls++; return { result: "x", costUsd: 0.01, resultRef: "x" }; }, load: async () => null,
  }));
  assert.equal(reservations, 1); assert.equal(calls, 0);
});
