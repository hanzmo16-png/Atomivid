/**
 * Podcast — asistente Premium 4.0 en 4 pantallas (Participantes · Contenido · Estilo · Producir), formato de 1 o 2
 * personas y borradores del asistente anterior (10 pasos). Sin red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCREENS, SCREEN_SECTIONS, STEP, STEPS, defaultDraft, loadDraft, screenErrors, screenOf, screenStart, withFormat } from "./wizard";

const ctx = { unavailableVoices: [] as string[] };

test("cuatro pantallas cubren los diez pasos una sola vez; quién habla va ANTES del guion", () => {
  assert.deepEqual([...SCREENS], ["Participantes", "Contenido", "Estilo", "Producir"]);
  const all = SCREEN_SECTIONS.flat();
  assert.equal(all.length, STEPS.length); assert.equal(new Set(all).size, STEPS.length);
  assert.ok(screenOf(STEP.participantes) < screenOf(STEP.tema), "los nombres existen cuando se escribe el guion (episodio 51883d1c)");
  assert.equal(screenOf(STEP.generacion), SCREENS.length - 1);
  for (let i = 0; i < SCREENS.length; i++) assert.equal(screenOf(screenStart(i)), i);
});

test("borradores del asistente de 10 pasos abren al inicio de su pantalla; «generación» se conserva", () => {
  const at = (step: number) => loadDraft(JSON.stringify({ ...defaultDraft(), step })).step;
  assert.equal(at(STEP.voces), screenStart(0)); assert.equal(at(STEP.avatares), screenStart(0));
  assert.equal(at(STEP.tema), screenStart(1)); assert.equal(at(STEP.musica), screenStart(2));
  assert.equal(at(STEP.vista), screenStart(3)); assert.equal(at(STEP.generacion), STEP.generacion);
  assert.equal(loadDraft(JSON.stringify({ step: 99 })).step, screenStart(0), "un paso desconocido no rompe el asistente");
});

test("la pantalla reúne los errores de sus secciones; la autorización del cargo no bloquea «Siguiente»", () => {
  const d = { ...defaultDraft(), modality: "dialogo" as const, mode: "dialogo" as const, count: 2 as const };
  const e = screenErrors(d, 0, ctx);
  assert.ok(e.some((x) => /voz/.test(x)) && e.some((x) => /avatar/.test(x)), e.join(" | "));
  assert.ok(screenErrors({ ...defaultDraft(), modality: null }, 0, ctx).some((x) => /Elige cómo/.test(x)));
  assert.ok(!screenErrors({ ...d, authorized: false, budgetUsd: 5 }, 3, ctx).some((x) => /autorizar/.test(x)));
});

test("formato 1 o 2 personas: en video con avatares cambia presentador ↔ conversación; en audio, una o dos voces", () => {
  const video = { ...defaultDraft(), modality: "avatar" as const, mode: "avatar" as const, count: 1 as const };
  const two = withFormat(video, 2);
  assert.equal(two.modality, "dialogo"); assert.equal(two.mode, "dialogo"); assert.equal(two.count, 2);
  const one = withFormat(two, 1);
  assert.equal(one.modality, "avatar"); assert.equal(one.mode, "avatar"); assert.equal(one.count, 1);
  const audio = withFormat({ ...defaultDraft(), modality: "audio" as const, mode: "narracion" as const }, 2);
  assert.equal(audio.modality, "audio"); assert.equal(audio.mode, "narracion"); assert.equal(audio.count, 2);
});
