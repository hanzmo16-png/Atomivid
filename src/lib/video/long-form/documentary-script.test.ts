import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDocumentaryScript } from "./documentary-script";

// Deliberadamente NO se mockea Anthropic ni se configura ANTHROPIC_API_KEY
// en estas pruebas — esta función NUNCA debe intentar llamar a Claude sin
// un research pack con fuentes, así que la prueba real es que falla ANTES
// de necesitar red ni credenciales.

test("generateDocumentaryScript lanza sin llamar a Claude si el research pack no tiene fuentes", async () => {
  await assert.rejects(
    () =>
      generateDocumentaryScript({
        researchPack: { topic: "Tema de prueba", sources: [], openQuestions: [] },
        mode: "curiosity_documentary",
        targetDurationSeconds: 540,
      }),
    /research pack no tiene fuentes/,
  );
});

test("generateDocumentaryScript con fuentes pero sin ANTHROPIC_API_KEY falla por credenciales (nunca por falta de fuentes)", async () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      () =>
        generateDocumentaryScript({
          researchPack: {
            topic: "Tema de prueba",
            sources: [{ id: "src-1", title: "Fuente de prueba", kind: "primary" }],
            openQuestions: [],
          },
          mode: "curiosity_documentary",
          targetDurationSeconds: 540,
        }),
      (err: unknown) => err instanceof Error && err.message.includes("ANTHROPIC_API_KEY"),
    );
  } finally {
    if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
  }
});
