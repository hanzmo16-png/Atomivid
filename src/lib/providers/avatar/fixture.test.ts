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
