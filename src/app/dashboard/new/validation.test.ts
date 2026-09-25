import { test } from "node:test";
import assert from "node:assert/strict";
import {
  avatarDurationSelectorApplies,
  avatarStatusFromProviderStatus,
  isAvatarConsentGiven,
  resolveMode,
  validateCommonFields,
  validateNewAvatarSubmission,
} from "./validation";

const VALID_COMMON = { topic: "Un tema", style: "Educativo", durationSeconds: 30, language: "es" };

test("validateCommonFields acepta campos válidos", () => {
  assert.equal(validateCommonFields(VALID_COMMON), null);
});

test("validateCommonFields rechaza campos vacíos", () => {
  assert.match(validateCommonFields({ ...VALID_COMMON, topic: "" }) ?? "", /Completa todos los campos/);
  assert.match(validateCommonFields({ ...VALID_COMMON, style: "" }) ?? "", /Completa todos los campos/);
  assert.match(validateCommonFields({ ...VALID_COMMON, durationSeconds: 0 }) ?? "", /Completa todos los campos/);
});

test("validateCommonFields rechaza idioma no soportado", () => {
  assert.match(validateCommonFields({ ...VALID_COMMON, language: "fr" }) ?? "", /Idioma no válido/);
});

test("validateCommonFields rechaza duración fuera de la lista permitida", () => {
  assert.match(validateCommonFields({ ...VALID_COMMON, durationSeconds: 45 }) ?? "", /Duración no válida/);
});

test("validateCommonFields rechaza tema/estilo demasiado largos", () => {
  assert.match(validateCommonFields({ ...VALID_COMMON, topic: "x".repeat(501) }) ?? "", /tema no puede superar/);
  assert.match(validateCommonFields({ ...VALID_COMMON, style: "x".repeat(101) }) ?? "", /estilo no puede superar/);
});

test("resolveMode acepta 'visual' sin importar el flag", () => {
  assert.deepEqual(resolveMode("visual", false), { ok: true, mode: "visual" });
  assert.deepEqual(resolveMode("visual", true), { ok: true, mode: "visual" });
});

test("resolveMode acepta 'avatar' solo si el flag del servidor está encendido", () => {
  assert.deepEqual(resolveMode("avatar", true), { ok: true, mode: "avatar" });
  const rejected = resolveMode("avatar", false);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.error, /modo avatar no está disponible/);
});

test("resolveMode rechaza cualquier valor que no sea 'visual' ni 'avatar' (POST manipulado)", () => {
  const rejected = resolveMode("hybrid", true);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.error, /Modo no válido/);
});

test("isAvatarConsentGiven solo acepta exactamente 'on' (valor real de un checkbox marcado)", () => {
  assert.equal(isAvatarConsentGiven("on"), true);
  assert.equal(isAvatarConsentGiven(null), false);
  assert.equal(isAvatarConsentGiven("true"), false);
  assert.equal(isAvatarConsentGiven("off"), false);
});

test("validateNewAvatarSubmission exige fotografía y nombre", () => {
  assert.match(
    validateNewAvatarSubmission({ hasPhotoFile: false, photoSizeBytes: 0, avatarName: "Mi avatar" }) ?? "",
    /Falta la fotografía/,
  );
  assert.match(
    validateNewAvatarSubmission({ hasPhotoFile: true, photoSizeBytes: 0, avatarName: "Mi avatar" }) ?? "",
    /Falta la fotografía/,
  );
  assert.match(
    validateNewAvatarSubmission({ hasPhotoFile: true, photoSizeBytes: 5000, avatarName: "" }) ?? "",
    /Falta el nombre/,
  );
});

test("validateNewAvatarSubmission rechaza un nombre demasiado largo", () => {
  const result = validateNewAvatarSubmission({
    hasPhotoFile: true,
    photoSizeBytes: 5000,
    avatarName: "x".repeat(81),
  });
  assert.match(result ?? "", /no puede superar/);
});

test("validateNewAvatarSubmission acepta una fotografía y nombre válidos", () => {
  assert.equal(
    validateNewAvatarSubmission({ hasPhotoFile: true, photoSizeBytes: 5000, avatarName: "Mi avatar" }),
    null,
  );
});

test("avatarStatusFromProviderStatus mapea completed -> ready", () => {
  assert.equal(avatarStatusFromProviderStatus("completed"), "ready");
});

test("avatarStatusFromProviderStatus mapea failed/cancelled -> failed", () => {
  assert.equal(avatarStatusFromProviderStatus("failed"), "failed");
  assert.equal(avatarStatusFromProviderStatus("cancelled"), "failed");
});

test("avatarStatusFromProviderStatus mapea queued/processing -> processing", () => {
  assert.equal(avatarStatusFromProviderStatus("queued"), "processing");
  assert.equal(avatarStatusFromProviderStatus("processing"), "processing");
});

/**
 * Contrato de duración (RC QA 2026-09-25, Blocker #3): el selector 30/60/90
 * solo tiene sentido para Reel y para Avatar con "Generar voz desde el
 * guion" — con "Grabar o subir mi voz"/"Voz IA desde texto" el video dura
 * lo que dure el audio real, nunca el objetivo elegido.
 */
test("avatarDurationSelectorApplies: Reel (mode visual) siempre lo usa, sin importar narrationSource", () => {
  assert.equal(avatarDurationSelectorApplies("visual", "tts"), true);
  assert.equal(avatarDurationSelectorApplies("visual", "recording"), true);
  assert.equal(avatarDurationSelectorApplies("visual", "tts_text"), true);
  assert.equal(avatarDurationSelectorApplies("visual", "anything"), true);
});

test('avatarDurationSelectorApplies: Avatar + "Generar voz desde el guion" (tts) sí lo usa como objetivo', () => {
  assert.equal(avatarDurationSelectorApplies("avatar", "tts"), true);
});

test('avatarDurationSelectorApplies: Avatar + "Grabar/subir mi voz" o "Voz IA desde texto" NO lo usa — duración real del audio', () => {
  assert.equal(avatarDurationSelectorApplies("avatar", "recording"), false);
  assert.equal(avatarDurationSelectorApplies("avatar", "tts_text"), false);
});
