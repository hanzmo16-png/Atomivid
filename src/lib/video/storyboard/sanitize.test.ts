import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeResidualMarkers, sanitizeStoryboardStrings } from "./sanitize";

test("elimina <END> al final de un texto", () => {
  assert.equal(sanitizeResidualMarkers("una frase normal.<END>"), "una frase normal.");
});

test("elimina <END> al final con espacio antes", () => {
  assert.equal(sanitizeResidualMarkers("una frase normal. <END>"), "una frase normal.");
});

test("elimina <END> al inicio de un texto", () => {
  assert.equal(sanitizeResidualMarkers("<END>una frase normal."), "una frase normal.");
});

test("no toca <END> en medio del texto (nunca cambia contenido semántico)", () => {
  const withMarkerInMiddle = "una frase <END> normal.";
  assert.equal(sanitizeResidualMarkers(withMarkerInMiddle), withMarkerInMiddle);
});

test("no toca un texto normal sin ningún marcador", () => {
  const normal = "a single pair of shoes by the door at dawn.";
  assert.equal(sanitizeResidualMarkers(normal), normal);
});

test("es insensible a mayúsculas/minúsculas", () => {
  assert.equal(sanitizeResidualMarkers("una frase.<end>"), "una frase.");
});

test("también limpia [END] y <STOP>", () => {
  assert.equal(sanitizeResidualMarkers("una frase.[END]"), "una frase.");
  assert.equal(sanitizeResidualMarkers("una frase.<STOP>"), "una frase.");
});

test("sanitizeStoryboardStrings recorre objetos anidados y arreglos sin tocar otros tipos", () => {
  const input = {
    a: "texto<END>",
    b: 42,
    c: null,
    d: true,
    e: ["uno<END>", "dos"],
    f: { g: "tres<END>" },
  };
  const result = sanitizeStoryboardStrings(input) as typeof input;
  assert.equal(result.a, "texto");
  assert.equal(result.b, 42);
  assert.equal(result.c, null);
  assert.equal(result.d, true);
  assert.deepEqual(result.e, ["uno", "dos"]);
  assert.equal((result.f as { g: string }).g, "tres");
});

test("sanitizeStoryboardStrings no muta el objeto original", () => {
  const input = { a: "texto<END>" };
  sanitizeStoryboardStrings(input);
  assert.equal(input.a, "texto<END>");
});
