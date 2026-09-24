import { test } from "node:test";
import assert from "node:assert/strict";
import { isLongFormScriptJson } from "./produce";

// El pipeline completo (generateLongFormVideoFromScript) requiere un
// render real de Remotion (bundle + renderMedia) — igual que
// generateVideoFromScript (Reel), NO tiene una prueba unitaria de
// extremo a extremo (eso lo cubre `npm run test:pipeline`, fuera de
// test:unit). Aquí se prueban las piezas puras que este módulo agrega.

test("isLongFormScriptJson acepta un guion con topic + beats[] con narración", () => {
  const valid = {
    topic: "Göbekli Tepe",
    beats: [{ id: "b1", type: "hook", purpose: "enganchar", narration: "Hace 11,000 años..." }],
  };
  assert.equal(isLongFormScriptJson(valid), true);
});

test("isLongFormScriptJson rechaza null/undefined/no-objeto", () => {
  assert.equal(isLongFormScriptJson(null), false);
  assert.equal(isLongFormScriptJson(undefined), false);
  assert.equal(isLongFormScriptJson("string"), false);
  assert.equal(isLongFormScriptJson(42), false);
});

test("isLongFormScriptJson rechaza un guion de Reel/Avatar (GeneratedScript: segments, no beats)", () => {
  const reelScript = { segments: [{ text: "hola", visualQuery: "sunset" }] };
  assert.equal(isLongFormScriptJson(reelScript), false);
});

test("isLongFormScriptJson rechaza beats[] vacío", () => {
  assert.equal(isLongFormScriptJson({ topic: "x", beats: [] }), false);
});

test("isLongFormScriptJson rechaza un beat sin narration o sin id", () => {
  assert.equal(isLongFormScriptJson({ topic: "x", beats: [{ id: "b1" }] }), false);
  assert.equal(isLongFormScriptJson({ topic: "x", beats: [{ narration: "texto" }] }), false);
});
