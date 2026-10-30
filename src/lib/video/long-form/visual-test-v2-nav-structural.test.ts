import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Prueba estructural (lectura de código fuente, sin DOM) del acceso directo a las pruebas sin costo de Long Form
 * (visual-test-v2). Simple UX 1.0: ya no está en el menú del cliente (el dueño lo vio en un Samsung como «Dry Run Long
 * Form» en la barra); vive en «Mi cuenta» → Herramientas internas, con el MISMO gate Long Form/allowlist.
 */
const APP = join(__dirname, "..", "..", "..", "app", "dashboard");
const LAYOUT_SOURCE = readFileSync(join(APP, "layout.tsx"), "utf8");
const ACCOUNT_SOURCE = readFileSync(join(APP, "cuenta", "page.tsx"), "utf8");

test("el menú del cliente no muestra herramientas internas (Dry Run, visual-test-v2, centro de mando)", () => {
  assert.equal(/Dry Run|visual-test-v2|command-center|Command Center/.test(LAYOUT_SOURCE), false);
});

test("«Mi cuenta» ofrece el acceso con el mismo gate Long Form/allowlist (isLongFormEnabled + isLongFormAllowlisted)", () => {
  assert.ok(ACCOUNT_SOURCE.includes("isLongFormEnabled() && isLongFormAllowlisted(user)"));
  assert.ok(ACCOUNT_SOURCE.includes('"/dashboard/long-form/visual-test-v2"'));
});

test("el acceso es solo navegación: sin fetch ni llamadas a la API de la prueba", () => {
  for (const src of [LAYOUT_SOURCE, ACCOUNT_SOURCE]) {
    assert.equal(src.includes("/api/long-form/visual-test-v2"), false);
    assert.equal(/fetch\s*\(/.test(src), false);
  }
});

test("layout.tsx no importa ni referencia ningún proveedor real de imagen/voz/footage ni process.env directamente", () => {
  assert.equal(/openaiImageProvider|images\.generate|api\.openai\.com|elevenlabs|pexels/i.test(LAYOUT_SOURCE), false);
  assert.equal(LAYOUT_SOURCE.includes("process.env"), false);
});
