/**
 * T46 cierre (E): the «Tu video incluirá» card is static (server page) while the script source is chosen in the
 * form. Its copy must be true for BOTH sources: it may not promise an AI-written script when the customer narrates
 * their own text verbatim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("la tarjeta no afirma «Guion escrito por IA» sin condición", () => {
  assert.ok(!page.includes('"Guion escrito por IA a partir de tu tema",'), "etiqueta incondicional de guion IA");
});

test("la tarjeta menciona las dos fuentes de guion", () => {
  assert.match(page, /guion escrito por IA[^"]*tu propio guion/i);
});
