import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * evaluateRenderStart (render-guard.test.ts) cubre la primera línea de
 * defensa contra doble render, pero la garantía real contra una carrera
 * (doble clic, dos pestañas abiertas a la vez) es el UPDATE condicional
 * `.eq("status", videoRequest.status)` en render/route.ts: Postgres
 * serializa los UPDATE concurrentes sobre la misma fila, así que si dos
 * requests leen "script_ready" al mismo tiempo, solo una de las dos
 * consigue que el WHERE siga cumpliéndose cuando le toca ejecutarse — la
 * otra actualiza 0 filas y debe tratarse como rechazo, no como éxito. No
 * es simulable con un mock liviano sin reimplementar semántica de
 * Postgres, así que esta prueba es estructural: confirma que el guard
 * sigue en el código fuente, para que no se pierda sin que un test falle.
 *
 * Este archivo vive fuera de app/api/generate/[id]/render/ a propósito:
 * `node --test <ruta>` trata las rutas de archivo pasadas por CLI como
 * patrones glob, y "[id]" se interpreta como una clase de caracteres —
 * un archivo de test colocado dentro de esa carpeta nunca se ejecuta (se
 * reportan 0 tests, sin ningún error visible). fs.readFileSync sí puede
 * leer esa ruta literal sin problema, así que basta con apuntar aquí a la
 * ruta real y dejar el archivo de test en un directorio sin corchetes.
 */
const ROUTE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "app",
  "api",
  "generate",
  "[id]",
  "render",
  "route.ts",
);

test("render/route.ts protege la transición a processing con un UPDATE condicionado al status leído", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");

  assert.match(
    source,
    /\.update\(\{[\s\S]*?status:\s*"processing"[\s\S]*?\}\)[\s\S]*?\.eq\("id",\s*id\)[\s\S]*?\.eq\("status",\s*videoRequest\.status\)/,
    "el UPDATE a processing debe seguir condicionado a .eq(\"status\", videoRequest.status)",
  );

  assert.match(
    source,
    /if\s*\(!updated \|\| updated\.length === 0\)/,
    "una carrera perdida (0 filas actualizadas) debe seguir tratándose como rechazo, no como éxito",
  );
});
