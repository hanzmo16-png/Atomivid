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

/**
 * Regresión del Blocker #3 de QA (2026-09-25): Hans reintentó una vez, la
 * generación llegó al servidor y falló de verdad, pero el mensaje
 * persistido (via renderFailureMessage en RequestCard) era el más
 * genérico posible sin ninguna pista de causa. Ambos catch de esta ruta
 * deben generar un diagnosticId propio y pasarlo consistentemente a
 * logScriptError/classifyScriptError — así el "(Código: X)" que ve el
 * usuario coincide exactamente con la línea de log que sí tiene la causa
 * técnica completa (status/type de Anthropic, ver script-error.test.ts).
 */
test("script/route.ts genera un diagnosticId propio por intento y lo pasa a la vez a logScriptError y classifyScriptError (nunca solo a uno de los dos)", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf-8");
  assert.match(
    source,
    /const diagnosticId = generateDiagnosticId\(\);\s*logScriptError\("POST \/script", error, diagnosticId\);\s*const message = classifyScriptError\(error, diagnosticId\);/,
    'el catch de generación real debe generar UN diagnosticId y reutilizarlo en log + mensaje, para que el "(Código: X)" que ve el usuario sea buscable en los logs',
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
    /catch \(error\) \{\s*const diagnosticId = generateDiagnosticId\(\);\s*logScriptError\("POST \/script \(inesperado\)", error, diagnosticId\);\s*return NextResponse\.json\(\{ error: classifyScriptError\(error, diagnosticId\) \}, \{ status: 500 \}\);\s*\}/,
    "cualquier fallo inesperado (no solo del proveedor de guion) debe seguir devolviendo JSON clasificado con su código de diagnóstico, nunca una excepción sin manejar",
  );
});
