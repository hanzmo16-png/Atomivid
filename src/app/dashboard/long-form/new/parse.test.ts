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

test("briefFieldConflict: el caso 54740b5a (texto «9 minutos, español», campos 7 / en) se detiene antes de gastar; sin contradicción no molesta", async () => {
  const { briefFieldConflict } = await import("./parse");
  const voyager = "Crea un documental cinematográfico para YouTube titulado: \"Voyager 1: la nave que abandonó el sistema solar\". Duración: 9 minutos. Idioma: español latinoamericano.";
  assert.match(briefFieldConflict(voyager, 7, "en")!, /dice 9 minutos/);
  assert.match(briefFieldConflict(voyager, 9, "en")!, /narración en español/);
  assert.equal(briefFieldConflict(voyager, 9, "es"), null);
  assert.equal(briefFieldConflict("Voyager 1: la nave que abandonó el sistema solar", 7, "es"), null);
  assert.equal(briefFieldConflict("Los 300 de las Termópilas", 7, "es"), null, "a number that is not a duration is ignored");
});
