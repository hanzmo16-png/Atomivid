import { test } from "node:test";
import assert from "node:assert/strict";
import { canAccessLongFormBeta, isBetaQaUser } from "../../video/long-form/private-access";
import { canAccessAudioStudio } from "../../audio-studio/access";
import { isInternalProductionOwner } from "../../billing/internal-production";

const QA = "95c182e1-2549-4ef8-a4a4-924fd2890683", OTHER = "11111111-2222-3333-4444-555555555555";
const qa = { id: QA, email: "qa@x.test", email_confirmed_at: "2026-11-24T00:00:00Z" };

test("BETA_QA_USER_IDS vacío o ausente: nadie entra (comportamiento previo intacto)", () => {
  assert.equal(canAccessLongFormBeta(qa, {}), false);
  assert.equal(canAccessLongFormBeta(qa, { BETA_QA_USER_IDS: "" }), false);
  assert.equal(canAccessLongFormBeta(qa, { BETA_QA_USER_IDS: " , no-uuid " }), false);
});

test("solo el UUID listado y con correo confirmado entra a Long Form y Audio Studio", () => {
  const env = { BETA_QA_USER_IDS: `${OTHER}, ${QA.toUpperCase()}` };
  assert.equal(isBetaQaUser(qa, env), true);
  assert.equal(canAccessLongFormBeta(qa, env), true);
  assert.equal(canAccessAudioStudio(qa, env), true);
  assert.equal(canAccessLongFormBeta({ ...qa, email_confirmed_at: undefined }, env), false);
  assert.equal(canAccessLongFormBeta({ ...qa, id: "99999999-2222-3333-4444-555555555555" }, env), false);
  assert.equal(canAccessLongFormBeta(null, env), false);
});

test("la cuenta QA no se vuelve dueña ni salta el interruptor del módulo", () => {
  const env = { BETA_QA_USER_IDS: QA, INTERNAL_PRODUCTION_OWNER_USER_ID: OTHER };
  assert.equal(isInternalProductionOwner(qa, env), false);
  assert.equal(canAccessAudioStudio(qa, { ...env, AUDIO_STUDIO_DISABLED: "1" }), false);
});

test("dueño y cuenta interna siguen entrando igual", () => {
  const owner = { id: OTHER, email: "owner@x.test", email_confirmed_at: "2026-11-24T00:00:00Z" };
  assert.equal(canAccessLongFormBeta(owner, { INTERNAL_PRODUCTION_OWNER_USER_ID: OTHER }), true);
  assert.equal(canAccessLongFormBeta(owner, { AVATAR_PREPARATION_OWNER_EMAIL: "OWNER@x.test" }), true);
});
