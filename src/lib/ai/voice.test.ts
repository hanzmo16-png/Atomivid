import { test } from "node:test";
import assert from "node:assert/strict";
import { getVoiceIdentity } from "./voice";

test("getVoiceIdentity nunca incluye 'speed' en voiceSettingsJson (es un ajuste por llamada, no de identidad de voz)", () => {
  const identity = getVoiceIdentity("es");
  const settings = JSON.parse(identity.voiceSettingsJson);
  assert.equal("speed" in settings, false);
});

test("getVoiceIdentity incluye los parámetros de voz relevantes (stability, similarity_boost, style, use_speaker_boost)", () => {
  const identity = getVoiceIdentity("es");
  const settings = JSON.parse(identity.voiceSettingsJson);
  assert.ok("stability" in settings);
  assert.ok("similarity_boost" in settings);
  assert.ok("style" in settings);
  assert.ok("use_speaker_boost" in settings);
});

test("getVoiceIdentity es determinística: misma llamada, mismo resultado", () => {
  assert.deepEqual(getVoiceIdentity("es"), getVoiceIdentity("es"));
});

test("getVoiceIdentity siempre trae un voiceId y modelId no vacíos", () => {
  const identity = getVoiceIdentity("es");
  assert.ok(identity.voiceId.length > 0);
  assert.ok(identity.modelId.length > 0);
});
