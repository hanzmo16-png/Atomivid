import { test } from "node:test";
import assert from "node:assert/strict";
import { availableVideoDurations, avatarDurationError, avatarRenderDurationError, estimateAvatarNarrationSeconds } from "@/lib/video/avatar/duration";
import {
  avatarDurationSelectorApplies,
  avatarStatusFromProviderStatus,
  isAvatarConsentGiven,
  resolveMode,
  validateCommonFields,
  validateNewAvatarSubmission,
} from "./validation";

const VALID_COMMON = { topic: "Un tema", style: "Educativo", durationSeconds: 30, language: "es" };

test("Avatar respeta el límite configurado sin recortar las opciones de Reel", () => {
  assert.deepEqual(availableVideoDurations("avatar", 45), [30]);
  assert.deepEqual(availableVideoDurations("avatar", 90), [30, 60, 90]);
  assert.deepEqual(availableVideoDurations("visual", 45), [30, 60, 90]);
  assert.equal(avatarDurationError(45, 45), null);
  assert.match(avatarDurationError(45.01, 45)!, /límite de Avatar es 45 segundos/);
  for (const seconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.match(avatarDurationError(seconds, 45)!, /No se pudo comprobar/);
});

test("incidente 5cb073e5: un objetivo de 30s no oculta un guion real estimado en 68.4s", () => {
  const row = { mode: "avatar", duration_seconds: 30, recorded_audio_path: null, avatar_provider_video_job_id: null,
    script_json: { segments: [{ text: Array(171).fill("palabra").join(" ") }] } };
  assert.equal(estimateAvatarNarrationSeconds(row.script_json.segments[0].text), 68.4);
  assert.match(avatarRenderDurationError(row, 45)!, /68.4 segundos/);
  row.script_json.segments[0].text = Array(75).fill("palabra").join(" ");
  assert.equal(avatarRenderDurationError(row, 45), null, "la edición manual permite continuar sin regenerar el guion");
  assert.match(avatarRenderDurationError({ ...row, recorded_audio_path: "u/r/recording.m4a", duration_seconds: 68 }, 45)!, /68.0 segundos/);
  assert.equal(avatarRenderDurationError({ ...row, mode: "visual", duration_seconds: 90 }, 45), null);
  assert.equal(avatarRenderDurationError({ ...row, recorded_audio_path: "u/r/recording.m4a", duration_seconds: 68, avatar_provider_video_job_id: "accepted" }, 45), null,
    "un resultado ya pagado permanece recuperable si cambia el límite");
});

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
