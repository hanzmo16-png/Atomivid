import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Regresión del QA real (2026-09-25, "AVATAR REAL HEYGEN ATTEMPT FAILED"):
 * un fallo real de avatar (pipeline.ts rechazando por
 * AVATAR_MODE_ENABLED=false, o cualquier otra causa específica) quedaba
 * guardado en error_message sin ningún "(Código: XXXXXXXX)" — y
 * renderFailureMessage() (job-error.ts) trata cualquier texto sin ese
 * sufijo como crudo/sin clasificar, degradándolo al genérico "No se pudo
 * completar este intento...", exactamente lo que Hans vio en vez de la
 * causa real (que sí estaba en la base de datos, confirmado leyendo la
 * fila real vía scripts/diagnose-avatar-request.ts).
 *
 * run-job.ts no puede probarse fácilmente sin un runtime de Supabase
 * completo (mismo motivo que otros archivos de este directorio usan
 * pruebas estructurales) — se fija aquí, por contenido de la fuente, que
 * el catch final compone el mensaje con el mismo mecanismo ya usado por
 * classifyScriptError/classifyRenderError.
 */
const RUN_JOB_PATH = path.join(__dirname, "run-job.ts");

test("run-job.ts: el catch final añade un código de diagnóstico a error_message (generateDiagnosticId, mismo patrón que render-error.ts)", () => {
  const source = fs.readFileSync(RUN_JOB_PATH, "utf-8");
  assert.match(
    source,
    /import\s*\{\s*generateDiagnosticId\s*\}\s*from\s*"\.\/render-error"/,
    "debe reutilizar el mismo generador de código ya usado por classifyScriptError/classifyRenderError, no uno nuevo",
  );
  assert.match(
    source,
    /const message = `\$\{rawMessage\} \(Código: \$\{diagnosticId\}\)`/,
    'error_message debe llevar el sufijo "(Código: XXXXXXXX)" para que renderFailureMessage() lo muestre tal cual, sin degradarlo al genérico',
  );
});

/**
 * Regresión del QA real (2026-09-25, "HEYGEN PROVIDER CONFIG INCOMPLETE"):
 * ProviderConfigurationError nunca nombra la variable que falta en su
 * .message (a propósito — nunca debe llegar al usuario), así que sin este
 * log soporte no podía saber si faltaba HEYGEN_API_KEY, DID_API_KEY, etc.
 * sin adivinar. Se fija aquí, por contenido de la fuente (mismo motivo
 * estructural que la prueba anterior), que el catch registra los nombres
 * de las variables faltantes correlacionados con el mismo diagnosticId, y
 * nunca sus valores.
 */
test("run-job.ts: el catch final registra las variables de entorno faltantes de ProviderConfigurationError junto al mismo diagnosticId", () => {
  const source = fs.readFileSync(RUN_JOB_PATH, "utf-8");
  assert.match(
    source,
    /import\s*\{\s*ProviderConfigurationError\s*\}\s*from\s*"@\/lib\/providers\/production"/,
    "debe importar ProviderConfigurationError para poder distinguirlo de cualquier otro error",
  );
  assert.match(
    source,
    /error instanceof ProviderConfigurationError && error\.missingEnvVars\.length > 0/,
    "debe comprobar específicamente ProviderConfigurationError.missingEnvVars antes de registrar nada",
  );
  assert.match(
    source,
    /variables faltantes: \$\{error\.missingEnvVars\.join\(", "\)\}/,
    "debe registrar los NOMBRES de las variables faltantes (nunca sus valores) correlacionados con el diagnosticId",
  );
});
