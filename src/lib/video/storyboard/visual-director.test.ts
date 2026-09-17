import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Regresión exacta del incidente en producción: la primera validación real
 * del Visual Director falló con "Failed to parse structured output as
 * JSON: Unterminated string in JSON at position 13771" — la respuesta se
 * había CORTADO por límite de tokens (8000 era insuficiente para un
 * storyboard completo), pero `messages.parse()` no expone `stop_reason`
 * antes de lanzar, así que un truncamiento se veía igual que un JSON
 * genuinamente inválido. Esta prueba estructural falla si alguien vuelve
 * a usar `messages.parse()` (que reintroduciría el bug) o si el límite de
 * tokens vuelve a bajar del valor que causó el incidente real.
 */
test("visual-director.ts usa messages.create (no messages.parse) para poder revisar stop_reason antes de parsear", () => {
  const source = readFileSync(path.join(__dirname, "visual-director.ts"), "utf8");
  assert.ok(source.includes(".messages.create("), "debería llamar a messages.create, no messages.parse");
  assert.ok(!source.includes(".messages.parse("), "no debería usar messages.parse (oculta stop_reason)");
});

test("visual-director.ts revisa stop_reason=max_tokens/model_context_window_exceeded como truncamiento explícito", () => {
  const source = readFileSync(path.join(__dirname, "visual-director.ts"), "utf8");
  assert.ok(source.includes('"max_tokens"'));
  assert.ok(source.includes('"model_context_window_exceeded"'));
});

test("el límite de tokens de salida por defecto es mayor al que causó el truncamiento real (8000)", () => {
  const source = readFileSync(path.join(__dirname, "visual-director.ts"), "utf8");
  const match = source.match(/ANTHROPIC_VISUAL_DIRECTOR_MAX_TOKENS["'\s|]*\|\|\s*["'](\d+)["']/);
  assert.ok(match, "debería haber un default configurable para MAX_OUTPUT_TOKENS");
  const defaultValue = Number(match![1]);
  assert.ok(defaultValue > 8000, `el default (${defaultValue}) debería ser mayor a 8000 (el valor que causó el truncamiento real)`);
});

test("el reintento tras truncamiento usa un presupuesto de tokens MAYOR, no el mismo que ya falló", () => {
  const source = readFileSync(path.join(__dirname, "visual-director.ts"), "utf8");
  assert.ok(source.includes("MAX_OUTPUT_TOKENS_RETRY"));
  assert.ok(/MAX_OUTPUT_TOKENS_RETRY\s*=\s*MAX_OUTPUT_TOKENS\s*\+/.test(source));
});

/**
 * Regresión del residuo "<END>" observado en un campo real (run
 * 35240163644, storyboard válido, stop_reason="end_turn" — no era
 * truncamiento). La sanitización debe ocurrir DESPUÉS de JSON.parse
 * (JSON ya confirmado válido) y ANTES de StoryboardSchema.safeParse —
 * nunca antes del chequeo de stop_reason/JSON.parse, para no poder
 * enmascarar un truncamiento o un JSON genuinamente inválido.
 */
test("sanitizeStoryboardStrings se aplica después de JSON.parse y antes de StoryboardSchema.safeParse", () => {
  const source = readFileSync(path.join(__dirname, "visual-director.ts"), "utf8");
  assert.ok(source.includes("sanitizeStoryboardStrings"), "debería importar y usar sanitizeStoryboardStrings");

  const jsonParseIndex = source.indexOf("JSON.parse(textBlock.text)");
  const sanitizeIndex = source.indexOf("sanitizeStoryboardStrings(parsed)");
  const safeParseIndex = source.indexOf("StoryboardSchema.safeParse(sanitized)");

  assert.ok(jsonParseIndex > -1 && sanitizeIndex > -1 && safeParseIndex > -1);
  assert.ok(jsonParseIndex < sanitizeIndex, "JSON.parse debe ocurrir antes de sanitizar");
  assert.ok(sanitizeIndex < safeParseIndex, "sanitizar debe ocurrir antes de validar con Zod");
});
