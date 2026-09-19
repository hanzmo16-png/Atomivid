import { test } from "node:test";
import assert from "node:assert/strict";
import { durationPresentation } from "./duration-presentation";
test("never substitutes requested duration for missing delivered duration", () => {
  for (const value of [null, NaN, Infinity, 0, -1]) assert.equal(durationPresentation(30, value).delivered, "Por verificar al cargar el archivo");
});
test("shorter and longer files keep both values and explain the difference", () => {
  assert.equal(durationPresentation(30, 30).reason, null);
  assert.match(durationPresentation(30, 21.589).reason!, /narración/);
  assert.match(durationPresentation(30, 42.794, "avatar").reason!, /audio/);
  assert.equal(durationPresentation(30, 42.794).delivered, "42.794 s");
});
