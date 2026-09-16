import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { inlineWorker } from "./inline";

/**
 * Regresión exacta del incidente en producción: POST /api/generate/[id]/render
 * fallaba con el mensaje genérico del cliente ("No se pudo completar la
 * acción...") — el cuerpo real era vacío/no-JSON porque, igual que pasó
 * antes con /api/generate/[id]/script, un import estático a nivel de
 * módulo (aquí: inline.ts → run-job.ts → generate-video.ts →
 * @remotion/bundler/@remotion/renderer) hacía que TODO el árbol de
 * imports de la ruta de render quedara envuelto en la cadena de carga
 * externa de Remotion de Turbopack — incluso cuando el worker realmente
 * seleccionado en runtime era "github-actions" y este código nunca se
 * ejecutaba. Si esa carga externa fallaba, la función se caía antes de
 * llegar a cualquier try/catch propio de la ruta.
 */
test("inline.ts nunca importa run-job/generate-video de forma estática (solo dentro de trigger)", () => {
  const source = fs.readFileSync(path.join(__dirname, "inline.ts"), "utf-8");

  const staticImports = [...source.matchAll(/^import[^;]+from\s+["']([^"']+)["']/gm)].map(
    (m) => m[1],
  );

  for (const forbidden of ["@/lib/video/run-job", "@/lib/video/generate-video", "./run-job"]) {
    assert.ok(
      !staticImports.includes(forbidden),
      `no debe haber un import estático de "${forbidden}" — debe ser un import() dentro de trigger()`,
    );
  }

  assert.ok(
    /await\s+import\(\s*["']@\/lib\/video\/run-job["']\s*\)/.test(source),
    "trigger() debe importar run-job de forma dinámica (perezosa)",
  );
});

test("inlineWorker expone el nombre correcto", () => {
  assert.equal(inlineWorker.name, "inline");
});
