import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewPodcastScript } from "./preflight.ts";

const longEnough = "En 1975 apareció una pregunta que nadie respondió. ¿Por qué nadie recordó aquella noche? " +
  "El testigo describió el lugar, la hora y la distancia. Al final debemos contrastar los testimonios. ";
const has = (text, code, lang = "es") => reviewPodcastScript(text, lang).findings.some(f => f.code === code);

test("inputs vacíos y por debajo del mínimo no pasan a producción", () => {
  assert.equal(reviewPodcastScript(" ", "es").decision, "INSUFFICIENT_INPUT");
  assert.ok(has("muy corto", "SHORT_SCRIPT"));
});
test("exceso de 30k caracteres produce REVISE y no trunca el guion", () => {
  const r = reviewPodcastScript("A".repeat(30_001), "es");
  assert.equal(r.decision, "REVISE");
  assert.ok(r.findings.some(f => f.code === "OVER_LIMIT"));
  assert.equal(r.characters, 30_001);
});
test("una introducción genérica se señala sin reescribirla", () => {
  const r = reviewPodcastScript("Bienvenidos a mi podcast. " + longEnough, "es");
  assert.ok(r.findings.some(f => f.code === "GENERIC_OPENING"));
  assert.equal("script" in r, false);
});
test("apertura interrogativa en español no recibe falsa alarma de falta de tensión", () => {
  assert.equal(has("¿Qué había detrás de esa puerta? " + longEnough, "OPENING_WITHOUT_TENSION"), false);
});
test("inglés tiene reglas propias", () => {
  const r = reviewPodcastScript("Welcome back to the podcast. Today we investigate a strange report. ".repeat(3), "en");
  assert.ok(r.findings.some(f => f.code === "GENERIC_OPENING"));
  assert.equal(r.language, "en");
});
test("repetición literal de un pasaje largo se detecta una sola vez", () => {
  const sentence = "El testigo llegó a casa sin recordar el camino y encontró un reloj detenido sobre una mesa vacía.";
  const r = reviewPodcastScript("¿Qué ocurrió esa noche? " + sentence + " " + sentence, "es");
  assert.equal(r.findings.filter(f => f.code === "REPEATED_PASSAGE").length, 1);
});
test("una frase de más de 44 palabras se señala", () => {
  const r = reviewPodcastScript("¿Por qué ocurrió? " + "palabra ".repeat(50) + ".", "es");
  assert.ok(r.findings.some(f => f.code === "LONG_SENTENCE"));
});
test("lectura sin llamadas de proveedores, sin probabilidades inventadas", () => {
  const r = reviewPodcastScript(longEnough.repeat(2), "es");
  assert.deepEqual(r, reviewPodcastScript(longEnough.repeat(2), "es"));
  assert.ok(r.limitations.some(l => /no predice retención/.test(l)));
  assert.ok(!JSON.stringify(r).includes("probability"));
});
test("fragmentos del informe se acotan a 100 caracteres", () => {
  const r = reviewPodcastScript("Hola a todos. " + "palabra ".repeat(70), "es");
  assert.ok(r.findings.every(f => !f.evidence || f.evidence.length <= 100));
});
test("rechazo explícito de idioma no soportado", () => {
  assert.throws(() => reviewPodcastScript(longEnough, "fr"), /Unsupported/);
});