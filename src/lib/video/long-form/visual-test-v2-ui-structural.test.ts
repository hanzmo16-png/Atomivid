import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pruebas estructurales (lectura de código fuente, sin DOM/React Testing
 * Library — el proyecto no trae esas dependencias y esta UI es mínima y
 * temporal, así que no se agregan solo para esto) de la UI administrativa
 * de Visual Test V2 Dry Run. Mismo principio que
 * render-route-cas.test.ts: confirma en el código fuente que ciertas
 * invariantes de seguridad siguen ahí, para que no se pierdan sin que un
 * test falle.
 */
const DASHBOARD_DIR = join(__dirname, "..", "..", "..", "app", "dashboard", "long-form", "visual-test-v2");
const PAGE_SOURCE = readFileSync(join(DASHBOARD_DIR, "page.tsx"), "utf8");
const BUTTON_SOURCE = readFileSync(join(DASHBOARD_DIR, "DryRunButton.tsx"), "utf8");

test("page.tsx aplica el mismo gate Long Form/allowlist que el resto del producto (isLongFormEnabled + isLongFormAllowlisted)", () => {
  assert.ok(PAGE_SOURCE.includes("isLongFormEnabled"));
  assert.ok(PAGE_SOURCE.includes("isLongFormAllowlisted"));
  assert.ok(PAGE_SOURCE.includes("notFound"));
});

test("DryRunButton.tsx hace POST exclusivamente a /api/long-form/visual-test-v2 con el body literal fijo { mode: \"dry_run\" }", () => {
  assert.ok(BUTTON_SOURCE.includes('"/api/long-form/visual-test-v2"'));
  assert.ok(BUTTON_SOURCE.includes('method: "POST"'));
  assert.ok(BUTTON_SOURCE.includes('JSON.stringify({ mode: "dry_run" })'));
});

test("DryRunButton.tsx contiene el botón con el texto exacto pedido", () => {
  assert.ok(BUTTON_SOURCE.includes("Ejecutar Dry Run Long Form"));
});

test("DryRunButton.tsx NO contiene ningún campo de formulario (sin <input>/<textarea>/<select>) — no puede aceptar prompts, cantidades ni costos", () => {
  assert.equal(/<input|<textarea|<select/i.test(BUTTON_SOURCE), false);
});

test("DryRunButton.tsx NO referencia mode:\"real\" ni ningún valor de mode que no sea el literal dry_run", () => {
  assert.equal(/mode\s*:\s*["']real["']/i.test(BUTTON_SOURCE), false);
  // El código (no el comentario de documentación) debe mandar exactamente el body literal.
  assert.ok(BUTTON_SOURCE.includes('body: JSON.stringify({ mode: "dry_run" })'));
});

test("DryRunButton.tsx y page.tsx nunca leen ni muestran process.env / variables de entorno", () => {
  assert.equal(BUTTON_SOURCE.includes("process.env"), false);
  assert.equal(PAGE_SOURCE.includes("process.env"), false);
});

test("DryRunButton.tsx no importa ni referencia ningún proveedor real de imagen/voz/footage (no hace ninguna llamada paga por su cuenta)", () => {
  assert.equal(/openaiImageProvider|images\.generate|api\.openai\.com|elevenlabs|pexels/i.test(BUTTON_SOURCE), false);
});

test("page.tsx no expone ningún control de REAL generation (sin botón/enlace de generación real)", () => {
  assert.equal(/generar imagen|real generation|generación real/i.test(PAGE_SOURCE), false);
});
