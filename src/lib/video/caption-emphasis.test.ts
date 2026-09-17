import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEmphasisSet, isEmphasisWord, normalizeWord } from "./caption-emphasis";

test("normalizeWord quita puntuación, mayúsculas y acentos", () => {
  assert.equal(normalizeWord("¡Disciplina!"), "disciplina");
  assert.equal(normalizeWord("Sueños,"), "suenos");
  assert.equal(normalizeWord("MOTIVACIÓN."), "motivacion");
});

test("las palabras del ejemplo del brief de calidad están en la lista por defecto", () => {
  const set = buildEmphasisSet();
  for (const word of ["motivación", "disciplina", "triunfan", "hábito", "constantes"]) {
    assert.ok(isEmphasisWord(word, set), `"${word}" debería estar en la lista por defecto`);
  }
});

test("una palabra del guion se une a la lista por defecto (no la reemplaza)", () => {
  const set = buildEmphasisSet(["Atomivid"]);
  assert.ok(isEmphasisWord("Atomivid", set));
  assert.ok(isEmphasisWord("disciplina", set), "la lista por defecto debe seguir vigente");
});

test("isEmphasisWord funciona con la puntuación real del texto narrado", () => {
  const set = buildEmphasisSet();
  assert.ok(isEmphasisWord("disciplina,", set));
  assert.ok(isEmphasisWord("¡Disciplina!", set));
});

test("una palabra que no está en ninguna lista no se marca como énfasis", () => {
  const set = buildEmphasisSet(["Atomivid"]);
  assert.equal(isEmphasisWord("el", set), false);
  assert.equal(isEmphasisWord("una", set), false);
});
