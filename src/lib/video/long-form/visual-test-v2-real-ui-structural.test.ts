import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pruebas estructurales (lectura de código fuente, sin DOM) de la
 * generación REAL controlada — mismo principio que
 * visual-test-v2-ui-structural.test.ts y render-route-cas.test.ts.
 */
const DASHBOARD_DIR = join(__dirname, "..", "..", "..", "app", "dashboard", "long-form", "visual-test-v2");
const ROUTE_PATH = join(__dirname, "..", "..", "..", "app", "api", "long-form", "visual-test-v2", "real", "route.ts");

const PAGE_SOURCE = readFileSync(join(DASHBOARD_DIR, "page.tsx"), "utf8");
const REAL_BUTTON_SOURCE = readFileSync(join(DASHBOARD_DIR, "RealGenerateButton.tsx"), "utf8");
const ROUTE_SOURCE = readFileSync(ROUTE_PATH, "utf8");

test("route real/route.ts delega la autorización en evaluateVisualTestV2RealRequest y no usa la allowlist de Long Form", () => {
  assert.ok(ROUTE_SOURCE.includes("evaluateVisualTestV2RealRequest"));
  assert.equal(ROUTE_SOURCE.includes("assertLongFormAccess"), false);
  assert.equal(ROUTE_SOURCE.includes("VISUAL_TEST_V2_REAL_CONFIRM_VALUE"), false);
});

test("route real/route.ts no lee prompts, cantidades ni costos del body", () => {
  assert.equal(/\.(prompt|count|shotIds|quantity|amountUsd)\b/.test(ROUTE_SOURCE), false);
});

test("route real/route.ts delega la ejecución en runVisualTestV2RealGeneration (lógica ya testeada aparte)", () => {
  assert.ok(ROUTE_SOURCE.includes("runVisualTestV2RealGeneration"));
});

test("route real/route.ts nunca expone el cuerpo/cause crudo de un error del proveedor al cliente", () => {
  assert.equal(/error\.cause|JSON\.stringify\(error\)/.test(ROUTE_SOURCE), false);
});

test("RealGenerateButton.tsx contiene el texto exacto del botón pedido", () => {
  assert.ok(REAL_BUTTON_SOURCE.includes("Generar 3 imágenes — máximo US$0.50"));
});

test("RealGenerateButton.tsx hace POST exclusivamente a /api/long-form/visual-test-v2/real con el token emitido por el servidor, después de una confirmación visible", () => {
  assert.ok(REAL_BUTTON_SOURCE.includes('"/api/long-form/visual-test-v2/real"'));
  assert.ok(REAL_BUTTON_SOURCE.includes('method: "POST"'));
  assert.ok(REAL_BUTTON_SOURCE.includes("confirm: spendAuthorizationToken"));
  assert.ok(REAL_BUTTON_SOURCE.includes("Confirmación de gasto"));
  assert.ok(REAL_BUTTON_SOURCE.includes('role="alertdialog"'));
  assert.equal(REAL_BUTTON_SOURCE.includes("VISUAL_TEST_V2_REAL_CONFIRM_VALUE"), false);
  assert.equal(REAL_BUTTON_SOURCE.includes("GENERATE_3_VISUAL_TEST_V2_IMAGES"), false);
  assert.equal(REAL_BUTTON_SOURCE.includes("visual-test-v2-spend-auth"), false);
});

test("RealGenerateButton.tsx NO contiene ningún campo de formulario (sin <input>/<textarea>/<select>) — no puede aceptar prompts, cantidades ni costos editables", () => {
  assert.equal(/<input|<textarea|<select/i.test(REAL_BUTTON_SOURCE), false);
});

test("RealGenerateButton.tsx recibe shotIds/costos como PROPS (no los calcula ni los hardcodea el cliente)", () => {
  assert.ok(REAL_BUTTON_SOURCE.includes("shotIds"));
  assert.ok(REAL_BUTTON_SOURCE.includes("estimatedTotalUsd"));
  assert.ok(REAL_BUTTON_SOURCE.includes("maxTotalUsd"));
});

test("RealGenerateButton.tsx nunca lee process.env ni importa código server-only (Supabase, proveedor OpenAI)", () => {
  assert.equal(REAL_BUTTON_SOURCE.includes("process.env"), false);
  assert.equal(/openaiImageProvider|createServiceClient|@supabase\/supabase-js/i.test(REAL_BUTTON_SOURCE), false);
});

test("page.tsx calcula shotIds/costos en el servidor a partir del manifest real (buildVisualTestV2Manifest) y los pasa como props — nunca hardcodeados sueltos", () => {
  assert.ok(PAGE_SOURCE.includes("buildVisualTestV2Manifest"));
  assert.ok(PAGE_SOURCE.includes("VISUAL_TEST_V2_REAL_SHOT_IDS"));
  assert.ok(PAGE_SOURCE.includes("RealGenerateButton"));
});

test("page.tsx usa el gate owner/admin (isCommandCenterAdmin + notFound) para ambos controles y emite la autorización en el servidor", () => {
  assert.ok(PAGE_SOURCE.includes("isCommandCenterAdmin"));
  assert.equal(PAGE_SOURCE.includes("isLongFormAllowlisted"), false);
  assert.ok(PAGE_SOURCE.includes("notFound"));
  assert.ok(PAGE_SOURCE.includes("spendAuthorizationToken={spendAuthorization.token}"));
  assert.ok(PAGE_SOURCE.includes("maxTotalUsd={spendAuthorization.maxUsd}"));
});

test("page.tsx mantiene también el botón de DRY_RUN existente (DryRunButton) — no se reemplaza, se añade al lado", () => {
  assert.ok(PAGE_SOURCE.includes("DryRunButton"));
});

test("nada en la página/botón real referencia el storyboard completo de 45 shots ni el orquestador de producción completa", () => {
  assert.equal(/storyboard-shots|produce-long-form-video|asset-resolver/i.test(PAGE_SOURCE), false);
  assert.equal(/storyboard-shots|produce-long-form-video|asset-resolver/i.test(REAL_BUTTON_SOURCE), false);
});
