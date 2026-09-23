import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScriptFromFile, InvalidScriptFileError } from "./script-loader";

function withTempFile(content: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-script-loader-test-"));
  const path = join(dir, "script.json");
  writeFileSync(path, content);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID_MINIMAL = JSON.stringify({
  meta: { topic: "Tema de prueba", isFixtureContent: false },
  researchPack: { sources: [{ id: "src-1", title: "Fuente de prueba", kind: "primary" }] },
  beats: [
    {
      id: "beat-1",
      type: "hook",
      purpose: "Abrir",
      narration: "Narración de prueba con suficientes palabras para ser válida.",
      claims: [{ id: "b1-c1", text: "Afirmación de prueba", support: "sourced", sourceIds: ["src-1"] }],
      emotionalTone: "tension",
    },
    {
      id: "beat-2",
      type: "payoff",
      purpose: "Cerrar",
      narration: "Cierre de prueba.",
      claims: [],
    },
  ],
});

test("loadScriptFromFile carga un guion válido y produce beats con la forma esperada", () => {
  withTempFile(VALID_MINIMAL, (path) => {
    const loaded = loadScriptFromFile(path);
    assert.equal(loaded.topic, "Tema de prueba");
    assert.equal(loaded.isFixtureContent, false);
    assert.equal(loaded.beats.length, 2);
    assert.equal(loaded.beats[0].id, "beat-1");
    assert.equal(loaded.beats[0].type, "hook");
    assert.equal(loaded.beats[0].claims?.[0].support, "sourced");
  });
});

test("loadScriptFromFile lanza InvalidScriptFileError con JSON malformado", () => {
  withTempFile("{ esto no es json válido", (path) => {
    assert.throws(() => loadScriptFromFile(path), InvalidScriptFileError);
  });
});

test("loadScriptFromFile lanza InvalidScriptFileError si falta un campo requerido", () => {
  const missingNarration = JSON.stringify({
    meta: { topic: "x", isFixtureContent: false },
    beats: [{ id: "beat-1", type: "hook", purpose: "p" }],
  });
  withTempFile(missingNarration, (path) => {
    assert.throws(() => loadScriptFromFile(path), InvalidScriptFileError);
  });
});

test("loadScriptFromFile lanza InvalidScriptFileError con un beat.type desconocido", () => {
  const badType = JSON.stringify({
    meta: { topic: "x", isFixtureContent: false },
    beats: [{ id: "beat-1", type: "not-a-real-type", purpose: "p", narration: "n" }],
  });
  withTempFile(badType, (path) => {
    assert.throws(() => loadScriptFromFile(path), InvalidScriptFileError);
  });
});

test("loadScriptFromFile carga el guion real de Göbekli Tepe (VIDEO #001) sin reconstrucción manual", () => {
  const realPath = join(process.cwd(), "content/long-form/gobekli-tepe-001/gobekli-script-002-final.json");
  const loaded = loadScriptFromFile(realPath);
  assert.equal(loaded.isFixtureContent, false);
  assert.equal(loaded.beats.length, 10);
  assert.ok(loaded.topic.includes("Göbekli Tepe"));
  const totalWords = loaded.beats.reduce((sum, b) => sum + b.narration.split(/\s+/).filter(Boolean).length, 0);
  assert.ok(totalWords >= 1400 && totalWords <= 1650, `palabras totales fuera de rango: ${totalWords}`);
});
