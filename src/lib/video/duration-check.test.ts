import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDuration, formatDurationWarning } from "./duration-check";

test("una duración exacta al objetivo está dentro de tolerancia", () => {
  const result = checkDuration(30, 30);
  assert.equal(result.withinTolerance, true);
});

test("regresión exacta del video auditado (fc7534a0): 30s pedidos, 21.589s reales, fuera de tolerancia", () => {
  const result = checkDuration(30, 21.589);
  assert.equal(result.withinTolerance, false);
  assert.ok(result.deviationPercent > 25 && result.deviationPercent < 30);
});

test("+10% exacto sigue dentro de tolerancia", () => {
  const result = checkDuration(30, 33);
  assert.equal(result.withinTolerance, true);
});

test("-10% exacto sigue dentro de tolerancia", () => {
  const result = checkDuration(30, 27);
  assert.equal(result.withinTolerance, true);
});

test("justo por fuera de +10% no está dentro de tolerancia", () => {
  const result = checkDuration(30, 33.5);
  assert.equal(result.withinTolerance, false);
});

test("formatDurationWarning menciona el objetivo, lo real y el porcentaje de desviación", () => {
  const result = checkDuration(30, 21.589);
  const message = formatDurationWarning(result);
  assert.ok(message.includes("30"));
  assert.ok(message.includes("21.59"));
  assert.ok(/m[aá]s corto/.test(message));
});

test("un video más largo de lo pedido se reporta como 'más largo', no 'más corto'", () => {
  const result = checkDuration(30, 40);
  const message = formatDurationWarning(result);
  assert.ok(/m[aá]s largo/.test(message));
});

test("production regression: both observed off-target narrations must stop before export", async () => {
  const { assertNarrationDuration } = await import("./duration-check");
  for (const seconds of [33.76, 21.589, NaN, Infinity, 0]) assert.throws(() => assertNarrationDuration(30, seconds));
  assert.doesNotThrow(() => assertNarrationDuration(30, 30));
});


test("measured Reel duration failures reopen editing, but uncertainty and other modes do not", async () => {
  const { assertNarrationDuration, needsNarrationEdit, NarrationDurationError } = await import("./duration-check");
  let measured: unknown;
  try { assertNarrationDuration(30, 24.01); } catch (e) { measured = e; }
  assert.ok(measured instanceof NarrationDurationError);
  assert.equal(needsNarrationEdit(measured, "visual"), true);
  assert.equal(needsNarrationEdit(measured, "avatar"), false);
  assert.equal(needsNarrationEdit(measured, "long_form"), false);
  assert.equal(needsNarrationEdit(new Error(measured.message), "visual"), false);
  assert.equal(needsNarrationEdit(new Error("provider outcome uncertain"), "visual"), false);
  try { assertNarrationDuration(30, NaN); } catch (e) { assert.equal(needsNarrationEdit(e, "visual"), false); }
});
