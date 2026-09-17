import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAvatarWebhook, verifyWebhookSecret } from "./webhook";
import { fixtureAvatarProvider } from "@/lib/providers/avatar/fixture";

test("verifyWebhookSecret rechaza si falta el secreto esperado (no configurado)", () => {
  assert.equal(verifyWebhookSecret(undefined, "any-secret"), false);
});

test("verifyWebhookSecret rechaza si falta el secreto recibido", () => {
  assert.equal(verifyWebhookSecret("expected-secret", null), false);
});

test("verifyWebhookSecret rechaza si los secretos no coinciden", () => {
  assert.equal(verifyWebhookSecret("expected-secret", "wrong-secret"), false);
});

test("verifyWebhookSecret acepta si ambos secretos coinciden exactamente", () => {
  assert.equal(verifyWebhookSecret("expected-secret", "expected-secret"), true);
});

test("verifyWebhookSecret rechaza si ambos están vacíos/undefined (nunca autentica por 'ausencia == ausencia')", () => {
  assert.equal(verifyWebhookSecret(undefined, null), false);
  assert.equal(verifyWebhookSecret("", ""), false);
});

test("handleAvatarWebhook devuelve 400 sin tocar la base de datos ante un payload no reconocido", async () => {
  let updateCalled = false;
  const outcome = await handleAvatarWebhook({
    provider: fixtureAvatarProvider,
    rawPayload: { not: "a valid payload" },
    updateJobStatus: async () => {
      updateCalled = true;
      return { error: null };
    },
  });
  assert.equal(outcome.status, 400);
  assert.equal(updateCalled, false);
});

test("handleAvatarWebhook actualiza el estado y devuelve 200 ante un payload válido", async () => {
  const calls: Array<{ providerJobId: string; status: string }> = [];
  const outcome = await handleAvatarWebhook({
    provider: fixtureAvatarProvider,
    rawPayload: { providerJobId: "fixture-video-job-1", status: "completed" },
    updateJobStatus: async (providerJobId, status) => {
      calls.push({ providerJobId, status });
      return { error: null };
    },
  });
  assert.equal(outcome.status, 200);
  assert.deepEqual(calls, [{ providerJobId: "fixture-video-job-1", status: "completed" }]);
});

test("handleAvatarWebhook devuelve 500 sin exponer el detalle del error de la base de datos si la actualización falla", async () => {
  const outcome = await handleAvatarWebhook({
    provider: fixtureAvatarProvider,
    rawPayload: { providerJobId: "fixture-video-job-1", status: "completed" },
    updateJobStatus: async () => ({ error: "detalle interno sensible de Postgres" }),
  });
  assert.equal(outcome.status, 500);
  assert.equal(JSON.stringify(outcome.body).includes("sensible"), false);
});
