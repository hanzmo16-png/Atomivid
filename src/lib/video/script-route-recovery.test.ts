import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Regresión del Blocker #2 de QA (2026-09-25): tras un "Failed to fetch"
 * en el cliente (la petición nunca llegó a completarse — ver
 * client-error.test.ts), la solicitud se queda exactamente en "pending",
 * como estaba. Este test fija que /api/generate/[id]/script POST sigue
 * aceptando un reintento real desde "pending" (además de "failed" y
 * "script_ready", los otros dos estados desde los que ya se permitía
 * generar/regenerar), para que "Generar guion" siga siendo seguro de
 * pulsar de nuevo sin crear una segunda solicitud.
 *
 * Archivo fuera de app/api/generate/[id]/script/ a propósito: node --test
 * trata "[id]" en una ruta pasada por CLI como una clase de caracteres de
 * glob y un test colocado ahí dentro nunca se ejecutaría (mismo problema
 * ya documentado en render-route-cas.test.ts).
 */
const ROUTE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "app",
  "api",
  "generate",
  "[id]",
  "script",
  "route.ts",
);

test('script/route.ts POST sigue permitiendo generar/regenerar el guion desde "pending", "failed" y "script_ready"', () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");
  assert.match(
    source,
    /videoRequest\.status !== "pending" &&\s*videoRequest\.status !== "failed" &&\s*videoRequest\.status !== "script_ready"/,
    'el guard de estado debe seguir aceptando exactamente "pending", "failed" y "script_ready" — nunca bloquear un reintento real desde pending',
  );
});

test("script/route.ts sigue marcando la solicitud como failed (con mensaje clasificado) si la generación real falla, nunca la deja en un estado indefinido", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");
  assert.match(
    source,
    /status:\s*"failed",\s*error_message:\s*message,\s*script_json:\s*null/,
    "un fallo de generación real (proveedor, calidad) debe seguir marcando failed con el mensaje ya clasificado por classifyScriptError",
  );
});

test("script/route.ts define maxDuration explícito, para que Vercel no corte la función a medias durante una llamada real al proveedor de guion", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");
  assert.match(
    source,
    /export const maxDuration = 60/,
    "sin este límite explícito, una función cortada a medias por la plataforma puede dejar la solicitud sin marcar como fallida",
  );
});

test("script/route.ts envuelve toda la ruta en un try/catch que siempre devuelve JSON válido, nunca un cuerpo vacío/sin manejar", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");
  assert.match(
    source,
    /catch \(error\) \{\s*logScriptError\("POST \/script \(inesperado\)", error\);\s*return NextResponse\.json\(\{ error: classifyScriptError\(error\) \}, \{ status: 500 \}\);\s*\}/,
    "cualquier fallo inesperado (no solo del proveedor de guion) debe seguir devolviendo JSON clasificado, nunca una excepción sin manejar",
  );
});
