import assert from "node:assert/strict";
import test from "node:test";

import { inferTone } from "./tone";

test("mapea el estilo del formulario a tonos base", () => {
  const tones = inferTone({ style: "Motivacional" });
  assert.ok(tones.includes("motivational"));
});

test("historias de terror infiere tensión", () => {
  const tones = inferTone({ style: "Historias de terror" });
  assert.equal(tones[0], "tension");
});

test("las palabras clave del tema/guion pesan más que el estilo genérico", () => {
  // Estilo "Curiosidades" (reflective/energetic de base) pero el tema es
  // claramente sobre tecnología/IA — debe ganar "technology".
  const tones = inferTone({
    style: "Curiosidades",
    topic: "Cómo la inteligencia artificial está cambiando todo",
  });
  assert.equal(tones[0], "technology");
});

test("detecta tensión por palabras clave sin depender del estilo", () => {
  const tones = inferTone({
    style: "Educativo",
    scriptText: "Una noche oscura, el miedo se apodera de la casa abandonada.",
  });
  assert.ok(tones.includes("tension"));
});

test("no reconoce 'ia' dentro de otra palabra (evita falso positivo)", () => {
  const tones = inferTone({ topic: "biografía de un artista" });
  assert.ok(!tones.includes("technology"));
});

test("funciona igual en español e inglés (palabras clave bilingües)", () => {
  const es = inferTone({ topic: "El lujo y la vida exclusiva" });
  const en = inferTone({ topic: "Luxury and the exclusive lifestyle" });
  assert.equal(es[0], "luxury");
  assert.equal(en[0], "luxury");
});

test("sin ninguna señal, cae a un tono neutro por defecto", () => {
  const tones = inferTone({});
  assert.deepEqual(tones, ["reflective"]);
});

test("estilo desconocido no revienta, solo usa las palabras clave", () => {
  const tones = inferTone({ style: "Estilo Inventado Que No Existe", topic: "energía y acción" });
  assert.ok(tones.includes("energetic"));
});
