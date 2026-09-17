import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureAvatarProvider } from "./fixture";
import { AvatarProviderError } from "../types";

test("createAvatar exige consentimiento incluso en el fixture (defensa en profundidad)", async () => {
  await assert.rejects(
    () => fixtureAvatarProvider.createAvatar({ photoBuffer: Buffer.from("x"), mimeType: "image/jpeg", consentGiven: false }),
    (err: unknown) => err instanceof AvatarProviderError && err.reason === "consent_missing",
  );
});

test("ciclo completo determinístico: crear avatar → generar video, sin red", async () => {
  const avatar = await fixtureAvatarProvider.createAvatar({
    photoBuffer: Buffer.from("fake-photo"),
    mimeType: "image/jpeg",
    consentGiven: true,
  });
  assert.equal(avatar.status, "completed");

  const video = await fixtureAvatarProvider.generateVideo({
    providerAvatarId: avatar.providerAvatarId,
    script: "Hola, este es un guion de prueba.",
    maxCostUsd: 1,
  });
  assert.ok(video.buffer.byteLength > 0);
  assert.equal(video.costUsd, 0);

  const status = await fixtureAvatarProvider.checkVideoStatus(video.providerJobId);
  assert.equal(status, "completed");
});

test("deleteAvatar siempre confirma éxito en el fixture (determinístico)", async () => {
  const result = await fixtureAvatarProvider.deleteAvatar("fixture-avatar-1");
  assert.equal(result.deleted, true);
});

test("estimateVideoCostUsd es una función pura (sin red) que crece con la longitud del guion", () => {
  const short = fixtureAvatarProvider.estimateVideoCostUsd({ script: "hola" });
  const long = fixtureAvatarProvider.estimateVideoCostUsd({ script: "hola ".repeat(200) });
  assert.ok(short >= 0);
  assert.ok(long > short);
});

test("cancelVideo siempre confirma éxito en el fixture (determinístico)", async () => {
  const result = await fixtureAvatarProvider.cancelVideo("fixture-video-job-1");
  assert.equal(result.cancelled, true);
});

test("processWebhookPayload normaliza un payload reconocible", () => {
  const result = fixtureAvatarProvider.processWebhookPayload({ providerJobId: "fixture-video-job-1", status: "completed" });
  assert.deepEqual(result, { providerJobId: "fixture-video-job-1", status: "completed" });
});

test("processWebhookPayload devuelve null (nunca lanza) ante un payload malformado", () => {
  assert.equal(fixtureAvatarProvider.processWebhookPayload(null), null);
  assert.equal(fixtureAvatarProvider.processWebhookPayload({}), null);
  assert.equal(fixtureAvatarProvider.processWebhookPayload({ providerJobId: "x", status: "not-a-real-status" }), null);
  assert.equal(fixtureAvatarProvider.processWebhookPayload("just a string"), null);
});
