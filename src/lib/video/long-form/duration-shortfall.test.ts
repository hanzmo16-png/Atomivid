import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNarrationCoversRequestedDuration,
  assertScriptCoversRequestedDuration,
  LONG_FORM_MIN_DURATION_RATIO,
  LongFormDurationShortfallError,
  renderedDurationMismatch,
} from "./duration-shortfall";
import { LONG_FORM_DURATION_HARD_TOLERANCE, LONG_FORM_NARRATION_WORDS_PER_SECOND } from "./duration-budget";
import { isCustomerSafeError } from "./output-policy";

const words = (n: number) => [{ narration: Array.from({ length: n }, () => "palabra").join(" ") }];

test("la puerta usa la misma tolerancia dura del guion (−25 %)", () => {
  assert.equal(LONG_FORM_MIN_DURATION_RATIO, 1 - LONG_FORM_DURATION_HARD_TOLERANCE);
});

test("guion: 300 s pedidos — 75 % pasa, por debajo se detiene con mensaje seguro para el cliente", () => {
  const atLimit = Math.ceil(300 * 0.75 * LONG_FORM_NARRATION_WORDS_PER_SECOND);
  assert.doesNotThrow(() => assertScriptCoversRequestedDuration(words(atLimit), 300));
  assert.throws(() => assertScriptCoversRequestedDuration(words(atLimit - 5), 300), (err: unknown) => {
    assert.ok(err instanceof LongFormDurationShortfallError);
    assert.ok(isCustomerSafeError(err));
    assert.equal(err.stage, "script");
    assert.match(err.customerMessage, /5 min pedidos/);
    return true;
  });
});

test("guion: sin duración pedida (planes antiguos) o más largo de lo pedido no se bloquea aquí", () => {
  assert.doesNotThrow(() => assertScriptCoversRequestedDuration(words(10), undefined));
  assert.doesNotThrow(() => assertScriptCoversRequestedDuration(words(10), null));
  assert.doesNotThrow(() => assertScriptCoversRequestedDuration(words(2000), 300));
});

test("narración medida: 200 s de 300 pedidos se detiene; 240 s pasa; NaN nunca pasa", () => {
  assert.throws(() => assertNarrationCoversRequestedDuration(200, 300), LongFormDurationShortfallError);
  assert.doesNotThrow(() => assertNarrationCoversRequestedDuration(240, 300));
  assert.throws(() => assertNarrationCoversRequestedDuration(Number.NaN, 300), LongFormDurationShortfallError);
  assert.doesNotThrow(() => assertNarrationCoversRequestedDuration(10, undefined));
});

test("MP4 medido vs compuesto: tolerancia max(2 s, 0.5 %); vacío o ilegible nunca coincide", () => {
  assert.equal(renderedDurationMismatch(299.2, 300), null);
  assert.equal(renderedDurationMismatch(1795, 1800), null);
  assert.ok(renderedDurationMismatch(240, 300));
  assert.ok(renderedDurationMismatch(1780, 1800));
  assert.ok(renderedDurationMismatch(0, 300));
  assert.ok(renderedDurationMismatch(Number.NaN, 300));
});
