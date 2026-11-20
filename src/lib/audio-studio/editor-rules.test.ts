import { test } from "node:test";
import assert from "node:assert/strict";
import { commitTargetMinutes, parseTargetMinutes, voiceReplacements } from "./editor-rules";

test("duración: se puede vaciar y escribir 5, 10, 20, 30, 45 y 60 sin que se reemplace", () => {
  assert.equal(parseTargetMinutes("", 5, 60), null);
  for (const n of [5, 10, 20, 30, 45, 60]) assert.equal(parseTargetMinutes(String(n), 5, 60), n);
  // Pasos intermedios al teclear «30»: «3» no se confirma (fuera de rango) y no fuerza 5.
  assert.equal(parseTargetMinutes("3", 5, 60), null);
  assert.equal(parseTargetMinutes("30", 5, 60), 30);
});

test("duración: al salir del campo se lleva al rango o se conserva la anterior", () => {
  assert.equal(commitTargetMinutes("30", 10, 5, 60), 30);
  assert.equal(commitTargetMinutes("3", 10, 5, 60), 5);
  assert.equal(commitTargetMinutes("999", 10, 5, 60), 60);
  assert.equal(commitTargetMinutes("", 10, 5, 60), 10);
  assert.equal(commitTargetMinutes("abc", 30, 5, 60), 30);
});

test("voces: propone sustituta disponible del mismo género, sin repetir", () => {
  const ok = new Set(["es-latam-m-profesional", "es-latam-m-calida", "es-latam-f-energica"]);
  const has = (id: string) => ok.has(id);
  assert.deepEqual(voiceReplacements(["es-latam-m-profesional", "es-latam-f-profesional"], "es", has), ["es-latam-m-profesional", "es-latam-f-energica"]);
  assert.equal(voiceReplacements(["es-latam-m-profesional"], "es", has), null, "todas disponibles: nada que cambiar");
  assert.equal(voiceReplacements(["es-latam-f-profesional"], "es", () => false), null, "sin sustituta posible");
});
