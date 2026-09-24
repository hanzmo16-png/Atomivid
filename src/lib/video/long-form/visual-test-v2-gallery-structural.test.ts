import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pruebas estructurales (lectura de código fuente, sin DOM) de la
 * galería de revisión — mismo principio que las demás pruebas
 * estructurales de Visual Test V2.
 */
const DASHBOARD_DIR = join(__dirname, "..", "..", "..", "app", "dashboard", "long-form", "visual-test-v2");
const PAGE_SOURCE = readFileSync(join(DASHBOARD_DIR, "page.tsx"), "utf8");
const REAL_BUTTON_SOURCE = readFileSync(join(DASHBOARD_DIR, "RealGenerateButton.tsx"), "utf8");
const GALLERY_SOURCE = readFileSync(join(__dirname, "visual-test-v2-gallery.ts"), "utf8");

test("visual-test-v2-gallery.ts nunca IMPORTA ningún proveedor real de imagen/voz/footage — solo lee registros ya existentes", () => {
  // Se busca en líneas de import (no en comentarios de documentación, que sí mencionan
  // "openaiImageProvider" a propósito para explicar que NO se usa aquí).
  const importLines = GALLERY_SOURCE.split("\n").filter((line) => line.trim().startsWith("import "));
  const importsText = importLines.join("\n");
  assert.equal(
    /openaiImageProvider|images\/openai|elevenlabs|pexels|providers\/image/i.test(importsText),
    false,
  );
});

test("visual-test-v2-gallery.ts nunca escribe nada (no llama a writeVisualTestV2ShotRecord ni a upload)", () => {
  assert.equal(/writeVisualTestV2ShotRecord|uploadVisualTestV2Image|writeVisualTestV2Ledger/.test(GALLERY_SOURCE), false);
});

test("page.tsx: la galería (buildVisualTestV2Gallery) se calcula DESPUÉS del gate de autorización (notFound), nunca antes", () => {
  const gateIndex = PAGE_SOURCE.indexOf("notFound();");
  const galleryCallIndex = PAGE_SOURCE.indexOf("buildVisualTestV2Gallery(");
  assert.ok(gateIndex !== -1, "el gate notFound() debe existir en page.tsx");
  assert.ok(galleryCallIndex !== -1, "la llamada a buildVisualTestV2Gallery debe existir en page.tsx");
  assert.ok(gateIndex < galleryCallIndex, "el gate de autorización debe ejecutarse antes de construir la galería");
});

test("page.tsx contiene el encabezado exacto de la sección de revisión", () => {
  assert.ok(PAGE_SOURCE.includes("VISUAL TEST V2 — REVISIÓN"));
});

test("page.tsx muestra shotId/status/costo/dimensiones/proveedor-modelo-calidad por cada imagen de la galería", () => {
  assert.ok(PAGE_SOURCE.includes("item.shotId"));
  assert.ok(PAGE_SOURCE.includes("item.status"));
  assert.ok(PAGE_SOURCE.includes("item.costUsd"));
  assert.ok(PAGE_SOURCE.includes("item.widthPx"));
  assert.ok(PAGE_SOURCE.includes("item.heightPx"));
  assert.ok(PAGE_SOURCE.includes("item.provider"));
  assert.ok(PAGE_SOURCE.includes("item.model"));
  assert.ok(PAGE_SOURCE.includes("item.quality"));
  assert.ok(PAGE_SOURCE.includes("Ver imagen completa"));
});

test("RealGenerateButton.tsx no dispara la generación automáticamente al montar/refrescar — no hay useEffect, y runReal se pasa por referencia al botón, nunca se invoca por su cuenta", () => {
  assert.equal(REAL_BUTTON_SOURCE.includes("useEffect"), false);
  // runReal solo debe aparecer definido ("function runReal() {") y referenciado como manejador del
  // botón por REFERENCIA (onClick={runReal}) — nunca invocado directamente en el cuerpo ("runReal();").
  assert.equal(REAL_BUTTON_SOURCE.includes("runReal();"), false);
  assert.ok(REAL_BUTTON_SOURCE.includes("onClick={runReal}"));
});

test("page.tsx sigue manteniendo DryRunButton y RealGenerateButton — la galería se AÑADE, no reemplaza nada", () => {
  assert.ok(PAGE_SOURCE.includes("DryRunButton"));
  assert.ok(PAGE_SOURCE.includes("RealGenerateButton"));
});
