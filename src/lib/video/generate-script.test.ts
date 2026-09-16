import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateScriptForRequest } from "./generate-script";

/**
 * Regresión exacta del incidente en producción: /api/generate/[id]/script
 * fallaba con 500 ("Failed to load external module @remotion/bundler") al
 * cargar la función, porque generateScriptForRequest vivía en el mismo
 * archivo que generateVideoFromScript — importar una función arrastraba
 * el módulo completo, incluyendo los imports de Remotion que la etapa de
 * guion nunca usa. Esta prueba falla si alguien vuelve a fusionar ambos
 * archivos o a importar Remotion/Node nativo aquí.
 */
test("generate-script.ts nunca importa Remotion ni módulos exclusivos del render", () => {
  const source = fs.readFileSync(path.join(__dirname, "generate-script.ts"), "utf-8");

  // Busca declaraciones import/require reales (from "..."/require("...")),
  // no cualquier aparición del texto — el propio archivo menciona
  // "@remotion/bundler" en un comentario explicando por qué NO lo importa,
  // y eso no debe contar como una importación real.
  const importedModules = [...source.matchAll(/(?:from\s+|require\()["']([^"']+)["']/g)].map(
    (m) => m[1],
  );

  for (const forbidden of ["@remotion/bundler", "@remotion/renderer", "node:fs", "node:path", "node:os"]) {
    assert.ok(
      !importedModules.includes(forbidden),
      `no debe importar "${forbidden}" — eso pertenece a la etapa de render`,
    );
  }
  assert.ok(
    !/\bgenerateVideoFromScript\b/.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")),
    "generate-script.ts no debe reexportar ni referenciar la etapa de render fuera de comentarios",
  );
});

test("generateScriptForRequest funciona con el proveedor fixture (sin red) y reporta el proveedor usado", async () => {
  process.env.SCRIPT_PROVIDER = "fixture";
  try {
    const { script, providerName } = await generateScriptForRequest({
      topic: "el espacio",
      style: "Curiosidades",
      durationSeconds: 30,
      language: "es",
    });

    assert.equal(providerName, "fixture");
    assert.ok(script.title.length > 0);
    assert.ok(script.segments.length > 0);
    for (const segment of script.segments) {
      assert.equal(typeof segment.text, "string");
      assert.equal(typeof segment.visualQuery, "string");
    }
  } finally {
    delete process.env.SCRIPT_PROVIDER;
  }
});
