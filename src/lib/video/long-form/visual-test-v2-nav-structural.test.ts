import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Prueba estructural (lectura de código fuente, sin DOM) del acceso
 * directo "Dry Run Long Form" en el nav del dashboard — mismo principio
 * que render-route-cas.test.ts y visual-test-v2-ui-structural.test.ts:
 * confirma en el código fuente que las invariantes de seguridad/UX
 * siguen ahí, para que no se pierdan sin que un test falle.
 */
const LAYOUT_SOURCE = readFileSync(
  join(__dirname, "..", "..", "..", "app", "dashboard", "layout.tsx"),
  "utf8",
);

test("layout.tsx calcula la visibilidad del acceso directo con el mismo gate Long Form/allowlist (isLongFormEnabled + isLongFormAllowlisted)", () => {
  assert.ok(LAYOUT_SOURCE.includes("isLongFormEnabled"));
  assert.ok(LAYOUT_SOURCE.includes("isLongFormAllowlisted"));
  assert.ok(LAYOUT_SOURCE.includes("showLongFormDryRun"));
});

test("layout.tsx contiene el texto exacto del botón/enlace \"Dry Run Long Form\"", () => {
  assert.ok(LAYOUT_SOURCE.includes("Dry Run Long Form"));
});

test("el enlace apunta exclusivamente a /dashboard/long-form/visual-test-v2 (solo navegación, sin ningún fetch/POST asociado)", () => {
  assert.ok(LAYOUT_SOURCE.includes('href="/dashboard/long-form/visual-test-v2"'));
  assert.equal(LAYOUT_SOURCE.includes("/api/long-form/visual-test-v2"), false);
  assert.equal(/fetch\s*\(/.test(LAYOUT_SOURCE), false);
});

test("ambas apariciones del enlace (nav de escritorio y de móvil) están condicionadas por showLongFormDryRun", () => {
  const occurrences = (LAYOUT_SOURCE.match(/showLongFormDryRun && \(/g) ?? []).length;
  assert.equal(occurrences, 2);
});

test("layout.tsx no importa ni referencia ningún proveedor real de imagen/voz/footage ni process.env directamente", () => {
  assert.equal(/openaiImageProvider|images\.generate|api\.openai\.com|elevenlabs|pexels/i.test(LAYOUT_SOURCE), false);
  assert.equal(LAYOUT_SOURCE.includes("process.env"), false);
});
