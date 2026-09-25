import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_OPEN_QUESTIONS, MAX_SOURCES, parseOpenQuestions, parseSources } from "./parse";

test("parseSources ignora líneas vacías y separa título/locator/nota por '|'", () => {
  const sources = parseSources("Título A | https://a.example | nota A\nTítulo B\n\n  ");
  assert.equal(sources.length, 2);
  assert.deepEqual(sources[0], {
    id: "src-1",
    title: "Título A",
    kind: "secondary",
    locator: "https://a.example",
    notes: "nota A",
  });
  assert.deepEqual(sources[1], { id: "src-2", title: "Título B", kind: "secondary", locator: undefined, notes: undefined });
});

test("parseSources usa la línea completa como título si no tiene '|'", () => {
  const [source] = parseSources("Solo un título sin separador");
  assert.equal(source.title, "Solo un título sin separador");
  assert.equal(source.locator, undefined);
});

test("parseSources acota a MAX_SOURCES para no inflar el prompt sin límite", () => {
  const raw = Array.from({ length: MAX_SOURCES + 10 }, (_, i) => `Fuente ${i}`).join("\n");
  assert.equal(parseSources(raw).length, MAX_SOURCES);
});

test("parseOpenQuestions ignora líneas vacías y acota a MAX_OPEN_QUESTIONS", () => {
  assert.deepEqual(parseOpenQuestions("¿Pregunta 1?\n\n  ¿Pregunta 2?  \n"), ["¿Pregunta 1?", "¿Pregunta 2?"]);
  const raw = Array.from({ length: MAX_OPEN_QUESTIONS + 5 }, (_, i) => `Pregunta ${i}`).join("\n");
  assert.equal(parseOpenQuestions(raw).length, MAX_OPEN_QUESTIONS);
});

test("ambas funciones devuelven arreglo vacío ante entrada vacía o solo espacios", () => {
  assert.deepEqual(parseSources(""), []);
  assert.deepEqual(parseSources("   \n  \n"), []);
  assert.deepEqual(parseOpenQuestions(""), []);
});
