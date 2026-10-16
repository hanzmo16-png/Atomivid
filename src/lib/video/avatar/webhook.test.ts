import { test } from "node:test";
import assert from "node:assert/strict";
import { avatarStatusesThatMayAdvanceTo, handleAvatarWebhook, verifyWebhookSecret } from "./webhook";
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

test("avatarStatusesThatMayAdvanceTo: el estado solo avanza (queued → processing → terminal) y repetirlo es idempotente", () => {
  assert.deepEqual(avatarStatusesThatMayAdvanceTo("queued").sort(), ["queued"]);
  assert.deepEqual(avatarStatusesThatMayAdvanceTo("processing").sort(), ["processing", "queued"]);
  assert.deepEqual(avatarStatusesThatMayAdvanceTo("completed").sort(), ["completed", "processing", "queued"]);
  assert.deepEqual(avatarStatusesThatMayAdvanceTo("failed").sort(), ["failed", "processing", "queued"]);
  assert.deepEqual(avatarStatusesThatMayAdvanceTo("cancelled").sort(), ["cancelled", "processing", "queued"]);
});

test("callbacks duplicados y tardíos no retroceden un trabajo completado (UPDATE condicionado como en la ruta)", async () => {
  const row = { avatar_provider_video_job_id: "fixture-video-job-1", avatar_render_status: "processing" };
  // Emula `.update(...).eq(job).in("avatar_render_status", avatarStatusesThatMayAdvanceTo(status))`.
  const updateJobStatus = async (providerJobId: string, status: Parameters<typeof avatarStatusesThatMayAdvanceTo>[0]) => {
    const allowed: string[] = avatarStatusesThatMayAdvanceTo(status);
    if (row.avatar_provider_video_job_id === providerJobId && allowed.includes(row.avatar_render_status)) row.avatar_render_status = status;
    return { error: null };
  };
  const seen: string[] = [];
  for (const status of ["completed", "completed", "processing", "failed"]) {
    const outcome = await handleAvatarWebhook({
      provider: fixtureAvatarProvider,
      rawPayload: { providerJobId: "fixture-video-job-1", status },
      updateJobStatus,
    });
    assert.equal(outcome.status, 200);
    seen.push(row.avatar_render_status);
  }
  assert.deepEqual(seen, ["completed", "completed", "completed", "completed"]);
});
