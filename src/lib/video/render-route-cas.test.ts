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

/**
 * Regresión exacta del incidente en producción (Código: 7bd9fef1): las
 * llamadas a Supabase en render/route.ts pueden lanzar una excepción
 * cruda (fallo de red/conexión que postgrest-js no atrapa) además de
 * devolver `{ error }` normalmente. Sin envolver cada etapa, esa
 * excepción caía directo en el catch-all y se clasificaba igual que
 * cualquier otro fallo — imposible de distinguir sin logs del servidor.
 */
test("render/route.ts etiqueta con RenderStageError las tres etapas que pueden lanzar una excepción cruda de Supabase", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");

  for (const stage of ["fetch_request", "check_subscription", "mark_processing"]) {
    assert.match(
      source,
      new RegExp(`RenderStageError\\("${stage}"`),
      `debe seguir envolviendo la etapa "${stage}" con RenderStageError`,
    );
  }
});

test('render/route.ts nunca pierde el mensaje ya clasificado del worker si la restauración a "failed" también falla', () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");

  // El bloque catch de worker.trigger() debe envolver su propio intento de
  // marcar la solicitud como "failed" en un try/catch — y en cualquier
  // caso (éxito, error devuelto, o excepción) debe seguir devolviendo el
  // `message` ya calculado por classifyRenderError, nunca uno nuevo.
  const workerCatchIndex = source.indexOf("logRenderError(`POST /render (worker:");
  assert.ok(workerCatchIndex !== -1, "debe seguir existiendo el catch de worker.trigger()");

  const restCatchIndex = source.indexOf(
    "POST /render (restaurar estado a failed, excepción)",
    workerCatchIndex,
  );
  assert.ok(
    restCatchIndex !== -1,
    "el intento de restaurar el estado a failed debe estar envuelto en su propio try/catch",
  );

  const returnIndex = source.indexOf(
    "NextResponse.json({ error: message }, { status: 500 })",
    restCatchIndex,
  );
  assert.ok(
    returnIndex !== -1,
    "debe seguir devolviendo el mensaje ya clasificado del worker, no uno nuevo, incluso si la restauración falla",
  );
});

/**
 * Regresión exacta del incidente en producción (Código cde1d3da): en
 * Vercel, si faltan GH_WORKER_TOKEN/GH_WORKER_REPO, getRenderWorker()
 * lanza MissingEnvVarError en vez de caer a inline (ver
 * src/lib/worker/index.test.ts). Esa excepción solo evita que la
 * solicitud quede bloqueada en "processing" si getRenderWorker() se
 * llama ANTES del UPDATE que la transiciona a ese estado — si el orden
 * se invirtiera algún día, la solicitud quedaría marcada "processing"
 * sin que ningún worker la esté procesando de verdad.
 */
test("render/route.ts llama a getRenderWorker() antes del UPDATE que transiciona a processing", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");

  const getWorkerIndex = source.indexOf("getRenderWorker()");
  assert.ok(getWorkerIndex !== -1, "debe seguir llamando a getRenderWorker()");

  const markProcessingIndex = source.indexOf('status: "processing"');
  assert.ok(markProcessingIndex !== -1, 'debe seguir existiendo el UPDATE a "processing"');

  assert.ok(
    getWorkerIndex < markProcessingIndex,
    "getRenderWorker() debe llamarse antes de transicionar la solicitud a \"processing\" — " +
      "si faltan las credenciales de GitHub Actions en Vercel, debe detenerse antes de tocar el estado",
  );
});
